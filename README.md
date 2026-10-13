# OpenPlayground

Use open-source, clean-room alternatives to popular creative and office apps, by [ArtCraft](https://github.com/storytold) and others, in your browser.

Releases are fetched every 15min.

> [!NOTE]
> Note: Hardware accelerated GPU is highly recommended!

### Optimizations

- Apps are recompiled with -O3 & SIMD acceleration
- WASM files compressed with gzip for faster load time
- Compile shaders in the background to prevent hanging
- Render viewers on the page's own GPU instead of in background workers
- Video frames are copied straight to the GPU as YUV & skips late frames so stacked clips play smoother
- Preload neighboring photos in background workers so LightCraft and LightCraft Classic don't freeze

### Features

- [Community plugins](https://github.com/akkk09/artcraft-store) integration
- Support for reading your system's fonts
- Dark theme follows your system preference
- Workaround to enable clipboard access
- In browser file explorer & file menu (draggable into your apps)

### Trademarks

This site and the apps it serves are not affiliated with, endorsed by or sponsored by Adobe, Microsoft, Autodesk, Avid, Bluebeam or Figma, Inc. Photoshop, Illustrator, InDesign, Lightroom, Premiere Pro, After Effects and Acrobat are trademarks of Adobe; Word, Excel, PowerPoint and Outlook of Microsoft; AutoCAD and Fusion 360 of Autodesk; Pro Tools of Avid; Bluebeam and Revu of Bluebeam; Figma of Figma, Inc. Their names appear only to say which product each open-source app is an alternative to.
