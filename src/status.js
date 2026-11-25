/**
 * JAV.guru Database & Catalog Status CLI
 */

import fs from 'node:fs';
import path from 'node:path';
import {
    CATALOG_DIR,
    ENRICHED_DIR,
    CHECKPOINT_PATH
} from './config.js';
import { loadAllCatalogItems } from './enricher.js';
import { PartitionManager } from './partition.js';

export function runStatus() {
    console.log(`\n======================================================`);
    console.log(`        🚀 JAV.GURU SCRAPER DATABASE STATUS           `);
    console.log(`======================================================\n`);

    // 1. Catalog Status
    console.log(`📁 CATALOG INDEX:`);
    const hasProdCatalog = fs.existsSync(CATALOG_DIR) && fs.readdirSync(CATALOG_DIR).some(f => /^javguru_catalog(?:_part\d+)?\.json$/.test(f));
    const catalogItems = loadAllCatalogItems(!hasProdCatalog);
    const catalogFiles = [];

    if (fs.existsSync(CATALOG_DIR)) {
        const files = fs.readdirSync(CATALOG_DIR)
            .filter(f => /^javguru_catalog(?:_part\d+|_test)?\.json$/.test(f))
            .sort();

        for (const f of files) {
            const fp = path.join(CATALOG_DIR, f);
            const stat = fs.statSync(fp);
            try {
                const arr = JSON.parse(fs.readFileSync(fp, 'utf8'));
                if (Array.isArray(arr)) {
                    catalogFiles.push({ file: f, count: arr.length, sizeMB: (stat.size / (1024 * 1024)).toFixed(2) });
                }
            } catch {}
        }
    }

    if (catalogFiles.length > 0) {
        for (const cf of catalogFiles) {
            console.log(`  * ${cf.file}: ${cf.count} titles (${cf.sizeMB} MB)`);
        }
        console.log(`  ----------------------------------------------------`);
        console.log(`  - Total Titles Indexed:  ${catalogItems.length}`);
    } else {
        console.log(`  - No catalog files found. Run: npm run index:all`);
    }

    console.log(`\n------------------------------------------------------\n`);

    // 2. Enriched Storage Status
    console.log(`📦 ENRICHED STORAGE (85 MB Partitions):`);
    const partitionManager = new PartitionManager(undefined, undefined, { silent: true });
    const stats = partitionManager.getStats();

    if (stats.partsSummary.length > 0) {
        for (const ps of stats.partsSummary) {
            console.log(`  * ${ps.file}: ${ps.items} titles (${ps.sizeMB} MB)`);
        }
        console.log(`  ----------------------------------------------------`);
        console.log(`  - Total Enriched Titles: ${stats.totalItems}`);
        console.log(`  - Total Resolved Streams:${stats.totalStreams.toLocaleString()}`);
        console.log(`  - Total Dataset Size:    ${stats.totalSizeMB} MB across ${stats.totalParts} partition(s)`);
    } else {
        console.log(`  - No enriched files found.`);
    }

    console.log(`\n------------------------------------------------------\n`);

    // 3. Progress Status
    console.log(`📊 PIPELINE PROGRESS:`);
    let pendingCount = 0;
    for (const c of catalogItems) {
        if (!partitionManager.has(c.id, c.code, c.slug)) pendingCount++;
    }

    const pct = catalogItems.length > 0
        ? (((catalogItems.length - pendingCount) / catalogItems.length) * 100).toFixed(1)
        : 0;

    console.log(`  - Completed:             ${catalogItems.length - pendingCount} / ${catalogItems.length} (${pct}%)`);
    console.log(`  - Remaining Pending:     ${pendingCount} titles`);

    if (fs.existsSync(CHECKPOINT_PATH)) {
        try {
            const cp = JSON.parse(fs.readFileSync(CHECKPOINT_PATH, 'utf8'));
            if (cp.catalog) {
                console.log(`  - Total Pages on Site:   ${cp.catalog.total_pages || 5791}`);
            }
            if (cp.enrichment) {
                console.log(`  - Last Enrichment Run:   ${cp.enrichment.last_run || 'N/A'}`);
                if (cp.enrichment.failed_ids && cp.enrichment.failed_ids.length > 0) {
                    console.log(`  - Failed IDs:            ${cp.enrichment.failed_ids.length} (${cp.enrichment.failed_ids.slice(0, 3).join(', ')}...)`);
                }
            }
        } catch {}
    }

    console.log(`\n======================================================\n`);
}

runStatus();
