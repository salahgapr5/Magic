SalMedia Pipeline, Part B (export) on top of Part A

Run:
  npm install
  npm start

Test (no network needed):
  node tests/run.js

First use:
  1. Keys: add OpenAI, Groq and Pexels and/or Pixabay keys. The OpenAI model is gpt-5.6-sol.
  2. New project: pick an empty folder. All files are written there.
  3. Choose the audio and the face photo. The overlay clip is optional (silent, muted, loops, OFF by default, switch it on per B-roll item).
  4. Run all steps.

Files written in the project folder:
  transcript.json, moments.json, plan.json, settings.json, project.json, slides/*.png, stock/* (clips and images), overlay.<ext>
  (audio and face photo are copied in too)

Folders:
  src/modules/   transcribe, moments, broll-plan, slides, project (Part 1)
                 stock, overlay, export, avatar-interface (kept ready for Part 2 and 3)
  src/assets/    icons-data.js (the 3D icon library, 16 MB, separate from the slide engine)
  src/hooks/     motion-ai.js (one empty hook for Motion AI)
  legacy/        old files from the first build (not used)

Part A changes:
  B-roll items are 8 to 12 s (a 12 to 16 s gap becomes two short items; moments keep 8 s of B-roll between them).
  One OpenAI model: gpt-5.6-sol. Old saved gpt-4.1-mini / gpt-5.6-luna are ignored.
  Stock: Pexels + Pixabay (one adapter per site in src/modules/stock/adapters). No match = PNG slide, reason saved in plan.json (fallbackReason).
  Regenerate / Replace / Delete work on PNG, clip and image items. Overlay is saved as overlay:true/false per item.

Part B (export):
  Press "Export video". It writes final.mp4 in the project folder (1080p, 30 fps, even size). The uploaded audio is the soundtrack of the whole video.
  Avatar moment: the clip from avatar-clips.json (avatar/<file>) if it exists, else the face photo for that time range.
  B-roll: PNG slide, stock clip (cut to the slot, never sped up), stock image. Overlay only on B-roll items with overlay:true.
  Overlay clip with transparency: laid on top. Overlay clip without transparency (black background): "screen" blend, so black is see-through.
  Face photo and avatar clips are fitted whole inside a blurred copy of themselves (never cropped or stretched). Stock and slides fill the frame.
  Parts of the video with no avatar and no B-roll show the face photo (a warning says how many).
  Cancel stops ffmpeg and removes the temp files and the half-written video.
  ffmpeg code: src/modules/export/ (ffmpeg-render.js is the SalMedia code plus a new 'media' segment type; makeProxy/detectScenes are not used).
Tests: node tests/run.js (offline, fake services) and node tests/export.js (real ffmpeg, tiny files, about 20 s).

Crossfade (Part B add-on): Settings has "Crossfade, seconds" (0 to 1, default 0 = hard cut). The next export uses it between avatar moments and B-roll.

Part C, Step 1 (AptAvatar test, nothing in the app changes yet):
  tools/aptavatar-test/aptavatar_test.sh  - run it on RunPod (80 GB). See the top of the file for the 3 files to put next to it.
  Part C Step 2 (clips, GPU start/stop) and Step 3 (Supabase lock + queue) wait for the test result.
