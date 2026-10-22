# Reference Impact Graph

Content items, the items they link to and the assets they use, from content links, content references and image/video links, including inside objects and arrays of objects. Pan/zoom, draggable nodes, search, content-type filters, and two highlight modes: **Blast radius** (everything that transitively links to the selected item, coloured by hop distance, cycle-safe) and **Dependencies**. The side panel gives counts, ranked dependents, the item's open localization issues and a Dynamic Content deep link, and lists **hubs** (on a typical Amplience hub: shared author and image items), **broken links** (only for fully scanned content types) and **items nothing links to**.

Limits: links are read from master-locale values; "not linked" does not mean unused (pages are reached by delivery key, slots by editions); capped or failed content types show targets as *unverified*, never broken; links in markdown text are not content links; the layout runs in the browser, so very large hubs would need server-side graph pagination.

---
[← Back to README](../README.md) · [All documentation](README.md)
