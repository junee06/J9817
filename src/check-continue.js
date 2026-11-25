/**
 * JAV.guru Auto-Continue Checker for GitHub Actions
 * Outputs CONTINUE <pending_count> or COMPLETE 0
 */

import { PartitionManager } from './partition.js';
import { loadAllCatalogItems, belongsToWorker } from './enricher.js';

function parseArgs() {
    const args = process.argv.slice(2);
    const opts = {
        isTest: false,
        workerId: null,
        totalWorkers: 1
    };

    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--test') {
            opts.isTest = true;
        } else if (args[i] === '--worker-id' && args[i + 1]) {
            const w = parseInt(args[i + 1], 10);
            opts.workerId = w > 0 ? w : null;
            i++;
        } else if (args[i] === '--total-workers' && args[i + 1]) {
            const t = parseInt(args[i + 1], 10);
            opts.totalWorkers = t > 0 ? t : 1;
            i++;
        }
    }
    return opts;
}

function checkContinue() {
    const opts = parseArgs();
    const catalog = loadAllCatalogItems(opts.isTest);

    if (!catalog || catalog.length === 0) {
        console.log('COMPLETE 0');
        return;
    }

    const partitionManager = new PartitionManager(undefined, undefined, {
        silent: true,
        workerId: opts.workerId
    });
    let pendingCount = 0;

    for (const item of catalog) {
        if (
            !partitionManager.has(item.id, item.code, item.slug) &&
            belongsToWorker(item, opts.workerId, opts.totalWorkers)
        ) {
            pendingCount++;
        }
    }

    if (pendingCount > 0) {
        console.log(`CONTINUE ${pendingCount}`);
    } else {
        console.log('COMPLETE 0');
    }
}

checkContinue();
