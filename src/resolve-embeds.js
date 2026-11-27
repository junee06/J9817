/**
 * JAV.guru Final Embed URL Backfill Resolver
 * Resolves `searcho_url` -> `final_embed_url` for all existing items in data/enriched/.
 * Each worker (--worker-id 1/2/3) only touches its own partition files to guarantee
 * zero git conflicts, zero duplicate work, and low heap usage.
 */

import fs from 'node:fs';
import path from 'node:path';
import v8 from 'node:v8';
import { HttpClient } from './client.js';
import { ENRICHED_DIR, BASE_URL } from './config.js';

function parseArgs() {
    const args = process.argv.slice(2);
    const opts = {
        workerId: null,
        maxMinutes: 270,
        concurrency: 4,
        limit: Infinity,
        isCheck: false
    };

    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--check') {
            opts.isCheck = true;
        } else if (args[i] === '--worker-id' && args[i + 1]) {
            const w = parseInt(args[i + 1], 10);
            opts.workerId = w > 0 ? w : null;
            i++;
        } else if (args[i] === '--max-minutes' && args[i + 1]) {
            const m = parseFloat(args[i + 1]);
            if (!isNaN(m) && m > 0) opts.maxMinutes = m;
            i++;
        } else if (args[i] === '--concurrency' && args[i + 1]) {
            const c = parseInt(args[i + 1], 10);
            if (!isNaN(c) && c > 0) opts.concurrency = Math.min(12, c);
            i++;
        } else if (args[i] === '--limit' && args[i + 1]) {
            const l = parseInt(args[i + 1], 10);
            opts.limit = l > 0 ? l : Infinity;
            i++;
        }
    }
    return opts;
}

function getOwnedFiles(workerId) {
    if (!fs.existsSync(ENRICHED_DIR)) return [];
    const all = fs.readdirSync(ENRICHED_DIR).filter(f => /^javguru_enriched.*\.json$/.test(f)).sort();
    if (!workerId) return all;
    return all.filter(f => {
        if (f.includes(`_w${workerId}_`)) return true;
        if (workerId === 1 && /^javguru_enriched_part\d+\.json$/.test(f)) return true;
        return false;
    });
}

function needsResolve(item) {
    if (!item || !Array.isArray(item.streams) || item.streams.length === 0) return false;
    return item.streams.some(s => s && s.searcho_url && !s.final_embed_url && !s.resolve_failed);
}

function saveAtomic(filePath, data) {
    const tmp = `${filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, filePath);
}

async function runResolver() {
    const opts = parseArgs();
    const files = getOwnedFiles(opts.workerId);

    if (opts.isCheck) {
        let pendingItems = 0;
        for (const f of files) {
            try {
                const items = JSON.parse(fs.readFileSync(path.join(ENRICHED_DIR, f), 'utf8'));
                for (const it of items) {
                    if (needsResolve(it)) pendingItems++;
                }
            } catch {}
        }
        if (pendingItems > 0) {
            console.log(`CONTINUE ${pendingItems}`);
            process.exit(0);
        } else {
            console.log('COMPLETE 0');
            process.exit(1);
        }
    }

    const startTime = Date.now();
    const maxExecutionMs = opts.maxMinutes * 60 * 1000;
    const client = new HttpClient({ delayMs: 80 });

    console.log(`\n======================================================`);
    console.log(`     🔗 JAV.GURU FINAL EMBED URL RESOLVER             `);
    console.log(`======================================================`);
    console.log(`- Worker ID:    ${opts.workerId || 'ALL'}`);
    console.log(`- Owned Files:  ${files.join(', ') || 'NONE'}`);
    console.log(`- Concurrency:  ${opts.concurrency}`);
    console.log(`- Max Minutes:  ${opts.maxMinutes} mins`);
    console.log(`- Run Limit:    ${opts.limit === Infinity ? 'ALL' : opts.limit}`);
    console.log(`======================================================\n`);

    let totalItemsProcessed = 0;
    let totalStreamsResolved = 0;
    let totalStreamsFailed = 0;
    let stopRequested = false;

    let currentFilePath = null;
    let currentItems = null;
    let currentDirty = false;

    const flushCurrent = () => {
        if (currentDirty && currentFilePath && currentItems) {
            saveAtomic(currentFilePath, currentItems);
            currentDirty = false;
        }
    };

    const handleExit = () => {
        if (stopRequested) return;
        stopRequested = true;
        console.log('\n💾 Signal received, flushing current partition...');
        flushCurrent();
        process.exit(0);
    };
    process.on('SIGINT', handleExit);
    process.on('SIGTERM', handleExit);

    for (const f of files) {
        if (stopRequested || totalItemsProcessed >= opts.limit) break;

        currentFilePath = path.join(ENRICHED_DIR, f);
        try {
            currentItems = JSON.parse(fs.readFileSync(currentFilePath, 'utf8'));
        } catch (err) {
            console.error(`❌ Failed to read ${f}: ${err.message}`);
            continue;
        }
        currentDirty = false;

        const pendingIndices = [];
        for (let i = 0; i < currentItems.length; i++) {
            if (needsResolve(currentItems[i])) pendingIndices.push(i);
        }

        console.log(`📂 ${f}: ${pendingIndices.length}/${currentItems.length} item(s) need final_embed_url.`);
        if (pendingIndices.length === 0) {
            currentItems = null;
            continue;
        }

        let cursor = 0;
        const worker = async () => {
            while (!stopRequested) {
                if (Date.now() - startTime >= maxExecutionMs) {
                    stopRequested = true;
                    break;
                }
                if (totalItemsProcessed >= opts.limit) {
                    stopRequested = true;
                    break;
                }

                const heapStats = v8.getHeapStatistics();
                if (heapStats.used_heap_size / heapStats.heap_size_limit >= 0.80) {
                    console.log('\n⚠️ Heap >= 80%. Flushing & handing off to next workflow...');
                    stopRequested = true;
                    break;
                }

                const pos = cursor++;
                if (pos >= pendingIndices.length) break;
                const itemIdx = pendingIndices[pos];
                const item = currentItems[itemIdx];

                let resolvedHere = 0;
                let failedHere = 0;

                await Promise.all(item.streams.map(async (s) => {
                    if (!s || !s.searcho_url || s.final_embed_url || s.resolve_failed) return;
                    const finalUrl = await client.resolveSearchoEmbed(s.searcho_url, item.url || BASE_URL);
                    if (finalUrl) {
                        s.final_embed_url = finalUrl;
                        resolvedHere++;
                    } else {
                        s.resolve_failed = true;
                        failedHere++;
                    }
                }));

                currentDirty = true;
                totalItemsProcessed++;
                totalStreamsResolved += resolvedHere;
                totalStreamsFailed += failedHere;

                if (totalItemsProcessed <= 10 || totalItemsProcessed % 25 === 0) {
                    console.log(`  [${totalItemsProcessed}] ✅ #${item.id} (${item.code || 'N/A'}): +${resolvedHere} embeds resolved, ${failedHere} failed`);
                    flushCurrent();
                }
            }
        };

        await Promise.all(Array.from({ length: opts.concurrency }, () => worker()));
        flushCurrent();
        currentItems = null;
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\n======================================================`);
    console.log(`🎉 Embed Resolution Batch Complete in ${elapsed}s`);
    console.log(`- Items Processed:   ${totalItemsProcessed}`);
    console.log(`- Streams Resolved:  ${totalStreamsResolved}`);
    console.log(`- Streams Failed:    ${totalStreamsFailed}`);
    console.log(`======================================================\n`);
}

runResolver().catch(err => {
    console.error('[Resolver] Fatal:', err);
    process.exit(1);
});
