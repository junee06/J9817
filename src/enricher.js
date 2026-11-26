/**
 * JAV.guru Detail & Stream Enrichment Engine
 * Reads indexed catalog, fetches full metadata (actresses, studio, director, synopsis),
 * extracts all searcho player embed iframes and stream servers,
 * and writes to partitioned JSON files strictly under 85 MB.
 */

import fs from 'node:fs';
import path from 'node:path';
import v8 from 'node:v8';
import { fileURLToPath } from 'node:url';
import { HttpClient } from './client.js';
import { PartitionManager } from './partition.js';
import { parseDetailHtml } from './parser.js';
import {
    CATALOG_DIR,
    CATALOG_FILE,
    CHECKPOINT_PATH,
    DATA_DIR,
    DEFAULT_DELAY_MS
} from './config.js';

const __filename = fileURLToPath(import.meta.url);

export function belongsToWorker(item, workerId, totalWorkers) {
    if (!workerId || !totalWorkers || totalWorkers <= 1) return true;
    let numId = parseInt(item?.id, 10);
    if (Number.isNaN(numId)) {
        const key = String(item?.slug || item?.code || item?.title || '0');
        numId = 0;
        for (let i = 0; i < key.length; i++) {
            numId = (numId * 31 + key.charCodeAt(i)) >>> 0;
        }
    }
    return (Math.abs(numId) % totalWorkers) === (workerId - 1);
}

function parseArgs() {
    const args = process.argv.slice(2);
    const options = {
        isTest: false,
        limit: Infinity,
        delayMs: DEFAULT_DELAY_MS,
        maxMinutes: 270,
        maxPartMb: 85,
        targetId: null,
        targetUrl: null,
        resolveEmbeds: false,
        direction: 'desc', // 'desc' (newest first) or 'asc' (oldest first)
        workerId: null,
        totalWorkers: 1
    };

    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--test') {
            options.isTest = true;
            options.limit = 3;
        } else if (args[i] === '--limit' && args[i + 1]) {
            const parsed = parseInt(args[i + 1], 10);
            options.limit = parsed > 0 ? parsed : Infinity;
            i++;
        } else if (args[i] === '--delay' && args[i + 1]) {
            options.delayMs = parseInt(args[i + 1], 10);
            i++;
        } else if (args[i] === '--max-minutes' && args[i + 1]) {
            options.maxMinutes = parseFloat(args[i + 1]);
            i++;
        } else if (args[i] === '--max-part-mb' && args[i + 1]) {
            options.maxPartMb = parseFloat(args[i + 1]);
            i++;
        } else if (args[i] === '--id' && args[i + 1]) {
            options.targetId = args[i + 1];
            i++;
        } else if (args[i] === '--url' && args[i + 1]) {
            options.targetUrl = args[i + 1];
            i++;
        } else if (args[i] === '--resolve') {
            options.resolveEmbeds = true;
        } else if (args[i] === '--direction' && args[i + 1]) {
            options.direction = args[i + 1].toLowerCase();
            i++;
        } else if (args[i] === '--worker-id' && args[i + 1]) {
            const w = parseInt(args[i + 1], 10);
            options.workerId = w > 0 ? w : null;
            i++;
        } else if (args[i] === '--total-workers' && args[i + 1]) {
            const t = parseInt(args[i + 1], 10);
            options.totalWorkers = t > 0 ? t : 1;
            i++;
        }
    }

    return options;
}

function getCheckpointPath(workerId) {
    return workerId
        ? path.join(DATA_DIR, `checkpoint_w${workerId}.json`)
        : CHECKPOINT_PATH;
}

function loadCheckpoint(checkpointPath = CHECKPOINT_PATH) {
    if (fs.existsSync(checkpointPath)) {
        try {
            return JSON.parse(fs.readFileSync(checkpointPath, 'utf8'));
        } catch {}
    }
    return {
        catalog: {},
        enrichment: {
            total_enriched: 0,
            last_index: 0,
            failed_ids: [],
            last_run: null
        }
    };
}

function saveCheckpoint(state, checkpointPath = CHECKPOINT_PATH) {
    if (!fs.existsSync(path.dirname(checkpointPath))) {
        fs.mkdirSync(path.dirname(checkpointPath), { recursive: true });
    }
    const tempPath = `${checkpointPath}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(state, null, 2), 'utf8');
    fs.renameSync(tempPath, checkpointPath);
}

export function loadAllCatalogItems(isTest = false) {
    if (isTest) {
        const testPath = path.join(CATALOG_DIR, 'javguru_catalog_test.json');
        if (fs.existsSync(testPath)) {
            try {
                return JSON.parse(fs.readFileSync(testPath, 'utf8'));
            } catch {}
        }
    }

    const items = [];
    if (!fs.existsSync(CATALOG_DIR)) return items;

    const files = fs.readdirSync(CATALOG_DIR)
        .filter(f => /^javguru_catalog(?:_part\d+)?\.json$/.test(f))
        .sort();

    for (const f of files) {
        try {
            const arr = JSON.parse(fs.readFileSync(path.join(CATALOG_DIR, f), 'utf8'));
            if (Array.isArray(arr)) items.push(...arr);
        } catch (e) {
            console.error(`[Enricher] Error loading catalog file ${f}: ${e.message}`);
        }
    }

    return items;
}

export async function runEnricher() {
    const opts = parseArgs();
    const startTime = Date.now();
    const maxExecutionMs = opts.maxMinutes * 60 * 1000;
    const maxPartSizeBytes = opts.maxPartMb * 1024 * 1024;
    const checkpointPath = getCheckpointPath(opts.workerId);

    const client = new HttpClient({ delayMs: opts.delayMs });
    const partitionManager = new PartitionManager(undefined, maxPartSizeBytes, {
        workerId: opts.workerId
    });
    const checkpoint = loadCheckpoint(checkpointPath);

    let pendingItems = [];
    let totalCatalogCount = 0;
    {
        let catalog = loadAllCatalogItems(opts.isTest);

        // If single target requested
        if (opts.targetId || opts.targetUrl) {
            const target = opts.targetUrl || opts.targetId;
            const idMatch = String(target).match(/\/(\d+)\//) || String(target).match(/^(\d+)$/);
            const targetId = idMatch ? parseInt(idMatch[1], 10) : null;

            const found = catalog.find(c => c.id === targetId || c.url === target);
            catalog = found ? [found] : [{
                id: targetId || 0,
                code: null,
                title: String(target),
                slug: String(target).split('/').filter(Boolean).pop(),
                url: String(target).startsWith('http') ? target : `https://jav.guru/${target}/`
            }];
        }

        if (catalog.length === 0) {
            console.log(`[Enricher] ⚠️ Catalog is empty. Please run catalog indexer first: npm run index`);
            return;
        }

        totalCatalogCount = catalog.length;

        // Direction sorting: default is desc (newest first). If asc, reverse
        if (opts.direction === 'asc') {
            catalog.reverse();
        }

        // Filter pending items not yet enriched (across ALL workers) AND assigned to this worker's shard
        pendingItems = catalog.filter(it =>
            !partitionManager.has(it.id, it.code, it.slug) &&
            belongsToWorker(it, opts.workerId, opts.totalWorkers)
        );
    }

    console.log(`\n======================================================`);
    console.log(`        🚀 JAV.GURU ENRICHMENT WORKER                 `);
    console.log(`======================================================`);
    console.log(`- Mode:             ${opts.isTest ? 'TEST' : 'PRODUCTION'}`);
    if (opts.workerId && opts.totalWorkers > 1) {
        console.log(`- Worker Shard:     ${opts.workerId} / ${opts.totalWorkers}`);
    }
    console.log(`- Direction:        ${opts.direction.toUpperCase()}`);
    console.log(`- Total in Catalog: ${totalCatalogCount}`);
    console.log(`- Already Enriched: ${partitionManager.allIds.size} (all workers)`);
    console.log(`- Pending (Shard):  ${pendingItems.length}`);
    console.log(`- Run Limit:        ${opts.limit === Infinity ? 'ALL' : opts.limit}`);
    console.log(`- Resolve Embeds:   ${opts.resolveEmbeds ? 'YES' : 'NO (Fast searcho URLs)'}`);
    console.log(`- Max Minutes:      ${opts.maxMinutes} mins`);
    console.log(`- Partition Limit:  ${opts.maxPartMb} MB`);
    console.log(`======================================================\n`);

    if (pendingItems.length === 0) {
        console.log(`🎉 All catalog items for this shard have already been enriched! No pending items.`);
        return;
    }

    let processedCount = 0;
    let successCount = 0;
    let failedCount = 0;
    const failedIds = [...(checkpoint.enrichment.failed_ids || [])];

    // Graceful interrupt handling
    let isTerminating = false;
    const handleExit = () => {
        if (isTerminating) return;
        isTerminating = true;
        console.log(`\n[Enricher] 💾 Saving partitions and checkpoint before exit...`);
        partitionManager.flush();
        checkpoint.enrichment.total_enriched = partitionManager.allIds.size;
        checkpoint.enrichment.last_run = new Date().toISOString();
        checkpoint.enrichment.failed_ids = failedIds;
        saveCheckpoint(checkpoint, checkpointPath);
        console.log(`[Enricher] ✅ Saved successfully. Exiting.`);
        process.exit(0);
    };

    process.on('SIGINT', handleExit);
    process.on('SIGTERM', handleExit);

    for (let i = 0; i < pendingItems.length && processedCount < opts.limit; i++) {
        if (Date.now() - startTime >= maxExecutionMs) {
            console.log(`\n⏳ Max execution time reached (${opts.maxMinutes} mins). Gracefully pausing run.`);
            break;
        }

        if (processedCount > 0 && processedCount % 10 === 0) {
            const heapStats = v8.getHeapStatistics();
            const heapRatio = heapStats.used_heap_size / heapStats.heap_size_limit;
            if (heapRatio >= 0.80) {
                const usedMb = Math.round(heapStats.used_heap_size / (1024 * 1024));
                const limitMb = Math.round(heapStats.heap_size_limit / (1024 * 1024));
                console.log(`\n⚠️ Heap memory threshold reached (${usedMb}MB / ${limitMb}MB = ${(heapRatio * 100).toFixed(1)}%). Flushing & handing off to next workflow...`);
                break;
            }
        }

        const item = pendingItems[i];
        processedCount++;
        const itemIdx = `[${processedCount}/${Math.min(pendingItems.length, opts.limit)}]`;

        process.stdout.write(`${itemIdx} Enriching #${item.id} [${item.code || 'N/A'}]... `);

        try {
            // 1. Fetch detail page HTML
            const detailHtml = await client.getVideoDetail(item.url || item.id);
            if (!detailHtml) {
                console.log(`❌ 404 / Empty detail page.`);
                failedCount++;
                if (!failedIds.includes(item.id)) failedIds.push(item.id);
                continue;
            }

            // 2. Parse detail
            const detail = parseDetailHtml(detailHtml, item.url, item);
            if (!detail) {
                console.log(`❌ Failed to parse detail HTML.`);
                failedCount++;
                if (!failedIds.includes(item.id)) failedIds.push(item.id);
                continue;
            }

            // 3. Optional deep embed resolution (following searcho redirects)
            if (opts.resolveEmbeds && detail.streams && detail.streams.length > 0) {
                for (const s of detail.streams) {
                    if (s.searcho_url) {
                        const finalEmbed = await client.resolveSearchoEmbed(s.searcho_url, detail.url);
                        if (finalEmbed) {
                            s.final_embed_url = finalEmbed;
                        }
                    }
                }
            }

            // 4. Save to partition
            partitionManager.add(detail);
            successCount++;

            console.log(`✅ "${(detail.title || '').slice(0, 35)}..." (${detail.streams.length} stream servers)`);

            // Periodically flush every 5 items
            if (successCount % 5 === 0) {
                partitionManager.flush();
                checkpoint.enrichment.total_enriched = partitionManager.allIds.size;
                checkpoint.enrichment.last_run = new Date().toISOString();
                saveCheckpoint(checkpoint, checkpointPath);
            }

        } catch (err) {
            console.log(`❌ Error: ${err.message}`);
            failedCount++;
            if (!failedIds.includes(item.id)) failedIds.push(item.id);
        }
    }

    // Final flush
    partitionManager.flush();
    checkpoint.enrichment.total_enriched = partitionManager.allIds.size;
    checkpoint.enrichment.failed_ids = failedIds;
    checkpoint.enrichment.last_run = new Date().toISOString();
    saveCheckpoint(checkpoint, checkpointPath);

    const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\n======================================================`);
    console.log(`🎉 Batch Completed!`);
    console.log(`- Processed Items:  ${processedCount}`);
    console.log(`- Success:          ${successCount}`);
    console.log(`- Failed / Skipped: ${failedCount}`);
    console.log(`- Total Enriched:   ${partitionManager.allIds.size}`);
    console.log(`- Total Partitions: ${partitionManager.parts.length}`);
    console.log(`- Elapsed:          ${elapsedSec}s`);
    console.log(`======================================================\n`);
}

// Auto-run if executed directly
if (process.argv[1] && (path.resolve(process.argv[1]) === path.resolve(__filename) || process.argv[1].endsWith('enricher.js'))) {
    runEnricher().catch(err => {
        console.error('[Enricher] ❌ Fatal error:', err);
        process.exit(1);
    });
}
