---
"diffx-cli": patch
---

Fix binary previews pinning the code out of view. Binary files (images, etc.)
render outside CodeView's scroller, and a tall stack of image previews — say a
diff that adds an app icon set — would fill the viewport and trap the code
scroller below the fold, unreachable until each image was marked viewed. They
now live in their own height-capped, scrollable band (and individual previews
are smaller), so the code is always reachable.
