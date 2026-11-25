# JAV.guru Scraper & Database Builder

Production-grade, zero-dependency scraper and database builder for [JAV.guru](https://jav.guru), featuring automated catalog indexing, dossier extraction, multi-server player searcho iframe extraction, and auto-sharding dataset partitions under 85 MB.

## ✨ Features

- **Full Catalog Indexer**: Crawls `https://jav.guru` across all ~5,791 pages (~139,000 titles) with automatic page count detection and ID deduplication.
- **Deep Detail & Stream Enrichment**:
  - Full dossiers: Code (e.g. `KSBJ-454`), title, release date, category, actresses, director, studio, label, genres, synopsis, and poster.
  - Multi-server player iframe extraction:
    - Automatically maps localized player buttons (`STREAM SB`, `STREAM VO`, `STREAM LU`, `STREAM DD`, `STREAM JK`, etc.).
    - Extracts and base64-decodes `iframe_url` searcho endpoints.
    - Also extracts direct third-party hoster iframes.
    - Built-in searcho token resolver to follow redirects to raw player URLs if desired.
- **Auto-Sharding Partition Manager**:
  - Automatically shards datasets (`javguru_enriched_part1.json`, `part2.json`, etc.) strictly under 85 MB to comply with GitHub's 100 MB hard limit.
- **Graceful Execution & Checkpointing**:
  - Resumes seamlessly from existing partitions and checkpoint.
  - Periodic auto-flushes every 5 items.
  - Clean exit handling on `SIGINT` / `SIGTERM` and timer expiration.
- **GitHub Actions Automation**:
  - Scheduled daily sync and manual `workflow_dispatch`.
  - Supports bidirectional execution (`desc` or `asc`).
  - Auto-continue loop with cooldown to process batches without timeouts.

---

## 📁 Dataset Schema (`javguru_enriched_part*.json`)

```json
{
  "id": 1081223,
  "code": "KSBJ-454",
  "title": "[KSBJ-454] The wife with a strong sense of justice who went to complain that “the moaning from next door is too loud!” later, the insane climax screams heard through the wall were those of my beloved wife… Toa Kotone",
  "slug": "ksbj-454-the-wife-with-a-strong-sense-of-justice-who-went-to-complain-that-the-moaning-from-next-door-is-too-loud-later-the-insane-climax-screams-heard-through-the-wall-were-those-of-my-belove",
  "release_date": "2026-11-14",
  "year": 2026,
  "category": "1080p",
  "actresses": [
    "Toa Kotone"
  ],
  "actors": [
    "Ataru Asano"
  ],
  "director": "Pa-ki-kimuko",
  "studio": "KSB Planning / Emanuel",
  "label": "KSBJ",
  "genres": [
    "Creampie",
    "Cuckold",
    "Drama",
    "Married",
    "Slender"
  ],
  "poster": "https://cdn.javtaku.com/wp-content/uploads/2026/11/ksbj00454pl.jpg",
  "screenshots": [],
  "synopsis": "Always love watching her get pounded by some older, fat or out-of-shape guy. What a legend she is to this day.",
  "streams": [
    {
      "server_id": "1",
      "server_name": "STREAM SB",
      "searcho_url": "https://jav.guru/searcho/?xd=97931646e697437777972656&bg=...",
      "url": "https://jav.guru/searcho/?xd=97931646e697437777972656&bg=...",
      "type": "iframe",
      "final_embed_url": "https://javclan.com/e/ebyww4ynda9y"
    },
    {
      "server_id": "2",
      "server_name": "STREAM VO",
      "searcho_url": "https://jav.guru/searcho/?td=07a78757f676679603769333&bg=...",
      "url": "https://jav.guru/searcho/?td=07a78757f676679603769333&bg=...",
      "type": "iframe",
      "final_embed_url": "https://caseyseemavoid.com/e/39g0ivgouxzp"
    }
  ],
  "url": "https://jav.guru/1081223/ksbj-454-the-wife-with-a-strong-sense-of-justice-who-went-to-complain-that-the-moaning-from-next-door-is-too-loud-later-the-insane-climax-screams-heard-through-the-wall-were-those-of-my-belove/"
}
```

---

## 🚀 Quick Start

### 1. Inspect Database & Progress
```bash
npm run status
```

### 2. Run Catalog Indexer
```bash
# Test run (first 2 pages)
npm run index:test

# Full crawl of all pages
npm run index:all

# Specific page range
node src/indexer.js --start 1 --pages 10
```

### 3. Run Detail & Stream Enrichment
```bash
# Test run (3 sample videos)
npm run enrich:test

# Enrich pending catalog titles
npm run enrich

# Enrich single video by ID or URL
node src/enricher.js --id 1081223
node src/enricher.js --url https://jav.guru/1081223/ksbj-454.../

# Enrich ascending (oldest first)
node src/enricher.js --direction asc
```

### 4. Check Pending Titles
```bash
npm run check
# Outputs: CONTINUE <pending_count> or COMPLETE 0
```
