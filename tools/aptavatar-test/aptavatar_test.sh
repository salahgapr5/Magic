#!/usr/bin/env bash
# SalMedia Part C, Step 1: AptAvatar test. Run this ON RunPod (80 GB GPU, about 100 GB free disk).
# It makes one 10 s and one 30 s avatar clip from YOUR audio and prints timings, size, GPU memory and licenses.
# Nothing here changes the app. When it ends, send me report.txt (and look at the videos yourself).
#
# Put these in /workspace/apt_test first:
#   face.png (or face.jpg)   your face photo
#   voice.mp3 (or .wav/.m4a) your voice in YOUR language, at least 35 seconds
#   broll.mp4                (optional) any 1080p stock clip, at least 6 seconds, to see if 720p looks even next to it
# Then:  bash aptavatar_test.sh
# Second run skips what is already installed/downloaded. Setup is slow only the first time.
set -u
W="${W:-/workspace/apt_test}"; AV="$W/AptAvatar"; OUT="$W/out"; R="$W/report.txt"
mkdir -p "$W" "$OUT"; : > "$R"
FACE="$(ls "$W"/face.png "$W"/face.jpg "$W"/face.jpeg "$W"/face.webp 2>/dev/null | head -1)"
VOICE="$(ls "$W"/voice.* 2>/dev/null | head -1)"; BROLL="$(ls "$W"/broll.* 2>/dev/null | head -1)"
FAKE="${FAKE_GEN:-0}"   # FAKE_GEN=1 = test THIS SCRIPT without a GPU (makes a fake clip). Never use it for the real test.
log()  { echo "[$(date +%H:%M:%S)] $*" | tee -a "$R"; }
rep()  { echo "$*" | tee -a "$R"; }
fail() { rep ""; rep "RESULT: STOPPED - $*"; rep "Send me report.txt and the last 30 lines of what you see."; exit 1; }
secs() { awk "BEGIN{printf \"%.1f\", $2-$1}"; }
now()  { date +%s.%N; }

[ -n "$FACE" ]  || fail "no face photo. Put face.png in $W"
[ -n "$VOICE" ] || fail "no voice file. Put voice.mp3 in $W"
rep "=== AptAvatar test $(date) ==="
rep "face: $FACE | voice: $VOICE | broll: ${BROLL:-none}"
T_ALL=$(now)

# ---------- 0. machine ----------
if [ "$FAKE" != 1 ]; then
  command -v nvidia-smi >/dev/null || fail "no GPU found (nvidia-smi missing). Start a GPU pod."
  rep "GPU: $(nvidia-smi --query-gpu=name,memory.total --format=csv,noheader | head -1)"
  MEMGB=$(nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits | head -1 | awk '{printf "%d", $1/1024}')
  [ "${MEMGB:-0}" -ge 70 ] || rep "WARNING: this GPU has about ${MEMGB} GB. The test is meant for 80 GB."
fi
FREE=$(df -BG "$W" | awk 'NR==2{gsub("G","",$4); print $4}'); rep "free disk: ${FREE} GB (need about 100)"
[ "${FREE:-0}" -ge 80 ] || rep "WARNING: low disk. The weights alone are very large."
command -v ffmpeg >/dev/null || { log "installing ffmpeg"; apt-get update -qq && apt-get install -y -qq ffmpeg >/dev/null 2>&1; }
command -v ffmpeg >/dev/null || fail "ffmpeg is missing and could not be installed"

# ---------- 1. setup (first run only) ----------
if [ "$FAKE" != 1 ] && [ ! -f "$W/.setup_done" ]; then
  T=$(now); log "SETUP: clone code"
  [ -d "$AV" ] || git clone -q https://github.com/TaoLiveAIGC/AptAvatar.git "$AV" || fail "git clone failed"
  PY=$(command -v python3.10 || command -v python3); rep "python: $($PY --version 2>&1) (the project asks for 3.10)"
  [ -d "$W/venv" ] || "$PY" -m venv "$W/venv" || fail "cannot make a python venv"
  # shellcheck disable=SC1091
  . "$W/venv/bin/activate"; pip -q install -U pip wheel setuptools
  log "SETUP: torch (big download)"; pip -q install torch==2.8.0 torchvision==0.23.0 --index-url https://download.pytorch.org/whl/cu128 || fail "torch install failed"
  log "SETUP: requirements"; (cd "$AV" && pip -q install -r requirements.txt) || fail "requirements install failed"
  log "SETUP: flash-attn (can take 10 to 30 minutes, it compiles)"; pip -q install ninja && MAX_JOBS="${MAX_JOBS:-8}" pip -q install flash_attn==2.8.0.post2 --no-build-isolation || fail "flash-attn install failed"
  pip -q uninstall -y flash_attn_3 >/dev/null 2>&1
  pip -q install -U "huggingface_hub" imageio imageio-ffmpeg >/dev/null 2>&1
  touch "$W/.setup_done"; rep "SETUP time: $(secs "$T" "$(now)") s"
fi
[ "$FAKE" != 1 ] && . "$W/venv/bin/activate"

# ---------- 2. weights (first run only) ----------
if [ "$FAKE" != 1 ] && [ ! -f "$W/.weights_done" ]; then
  T=$(now); log "WEIGHTS: downloading (about 40 GB or more)"
  python - <<PY || fail "weights download failed"
from huggingface_hub import snapshot_download
snapshot_download("TaoLiveAIGC/AptAvatar", local_dir="$AV/models/AptAvatar")
snapshot_download("TencentGameMate/chinese-wav2vec2-base", local_dir="$AV/models/chinese-wav2vec2-base")
PY
  touch "$W/.weights_done"; rep "WEIGHTS download time: $(secs "$T" "$(now)") s"
fi

# ---------- 3. licenses ----------
rep ""; rep "=== LICENSE CHECK (read this yourself, I am not a lawyer) ==="
if [ "$FAKE" != 1 ]; then
python - <<PY 2>&1 | tee -a "$R"
import os, glob
from huggingface_hub import HfApi, hf_hub_download
api = HfApi()
for repo in ["TaoLiveAIGC/AptAvatar", "TencentGameMate/chinese-wav2vec2-base"]:
    print("--", repo)
    try:
        info = api.model_info(repo)
        lic = [t for t in (info.tags or []) if t.startswith("license")]
        print("   license tags on the model page:", lic or "NONE SET")
        files = [s.rfilename for s in info.siblings]
        print("   license-like files:", [f for f in files if "licen" in f.lower() or "notice" in f.lower() or f.lower().startswith("readme")] or "none")
        for f in files:
            if f.lower().startswith("licen"):
                p = hf_hub_download(repo, f); print("   first lines of", f); print("   " + "\n   ".join(open(p, errors="ignore").read().splitlines()[:6]))
    except Exception as e:
        print("   could not read:", e)
PY
else rep "(skipped in FAKE mode)"; fi
rep "Known from the project page: the CODE is Apache 2.0. It says model weights may have SEPARATE terms. The Wan/InfiniteTalk parts it builds on have their own licenses too."
rep "You must check: can you use the weights for a business/commercial video product? If the page says only 'research', the answer is NO until the authors confirm."

# ---------- 4. inputs ----------
log "Preparing inputs"
ffmpeg -y -v error -i "$FACE" -frames:v 1 "$OUT/face_in.png" || fail "cannot read the face photo"
VD=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$VOICE" | awk '{printf "%d",$1}')
[ "${VD:-0}" -ge 31 ] || fail "voice file is only ${VD}s. Need at least 35 seconds."
ffmpeg -y -v error -t 10 -i "$VOICE" -ac 1 -ar 16000 "$OUT/a10.wav" && ffmpeg -y -v error -t 30 -i "$VOICE" -ac 1 -ar 16000 "$OUT/a30.wav" || fail "cannot cut the voice file"

# ---------- 5. generate ----------
run_one() { # name wav seconds
  local n="$1" wav="$2" len="$3"
  local mem="$OUT/$n.mem" lg="$OUT/$n.log" vid="$OUT/$n.mp4"
  rm -f "$vid" "$mem"; log "GENERATE $n ($len s of audio)"
  local T; T=$(now); local SP=""
  if [ "$FAKE" != 1 ]; then ( while true; do nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits >> "$mem"; sleep 1; done ) & SP=$!; fi
  if [ "$FAKE" = 1 ]; then
    ffmpeg -y -v error -f lavfi -i "testsrc2=s=1280x720:d=$len:r=25" -i "$wav" -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest "$vid"; RC=$?
    echo "Generate video chunk-0 done, cost time: 1.00s" > "$lg"
  else
    ( cd "$AV" && python generate_video.py --ckpt_dir models/AptAvatar --wav2vec_dir models/chinese-wav2vec2-base --cond_image "$OUT/face_in.png" --audio_path "$wav" --save_file "$vid" ) 2>&1 | tee "$lg" | tail -n 5; RC=${PIPESTATUS[0]}
  fi
  local E; E=$(now); [ -n "$SP" ] && kill "$SP" 2>/dev/null
  [ "$RC" = 0 ] && [ -s "$vid" ] || fail "generation of $n failed (exit $RC). See $lg"
  local TOTAL CH; TOTAL=$(secs "$T" "$E"); CH=$(grep -o 'cost time: [0-9.]*' "$lg" | awk '{s+=$3} END{printf "%.1f", s}')
  local PEAK="n/a"; [ -s "$mem" ] && PEAK=$(sort -n "$mem" | tail -1)
  local W_ DUR HA; W_=$(ffprobe -v error -select_streams v:0 -show_entries stream=width,height,r_frame_rate -of csv=p=0 "$vid" | tr ',' ' ')
  DUR=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$vid"); HA=$(ffprobe -v error -select_streams a -show_entries stream=codec_name -of csv=p=0 "$vid")
  rep "$n: total ${TOTAL} s | model compute ${CH} s | load+save+other $(awk "BEGIN{printf \"%.1f\", $TOTAL-$CH}") s | output (w h fps): $W_ | video length ${DUR} s (audio $len s) | audio stream: ${HA:-NONE} | peak GPU memory ${PEAK} MB"
  rep "$n: speed = $(awk "BEGIN{printf \"%.2f\", $TOTAL/$len}") s of waiting per 1 s of video (whole run, cold load included)"
  awk "BEGIN{d=$DUR-$len; if(d<0)d=-d; exit !(d>0.5)}" && rep "WARNING $n: video length differs from audio by more than 0.5 s"
  [ -n "$HA" ] || rep "WARNING $n: the clip has no audio stream"
  ffmpeg -y -v error -i "$vid" -vf "fps=1/3,scale=360:-1,tile=4x3" -frames:v 1 "$OUT/sheet_$n.png"
}
rep ""; rep "=== TIMINGS ==="
run_one clip10 "$OUT/a10.wav" 10
run_one clip30 "$OUT/a30.wav" 30

# ---------- 6. 720p next to 1080p B-roll ----------
if [ -n "$BROLL" ]; then
  log "Making compare_1080p.mp4 (B-roll, avatar clip, B-roll). Same fitting rule the app uses."
  ffmpeg -y -v error -stream_loop -1 -t 10 -i "$BROLL" -i "$OUT/clip10.mp4" -filter_complex \
"[0:v]trim=0:3,setpts=PTS-STARTPTS,fps=30,scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,setsar=1,format=yuv420p[a];\
[1:v]trim=0:5,setpts=PTS-STARTPTS,fps=30,split[s1][s2];[s1]scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,boxblur=25:3[bb];[s2]scale=1920:1080:force_original_aspect_ratio=decrease:flags=bicubic[ff];[bb][ff]overlay=(main_w-overlay_w)/2:(main_h-overlay_h)/2,setsar=1,format=yuv420p[b];\
[0:v]trim=3:6,setpts=PTS-STARTPTS,fps=30,scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,setsar=1,format=yuv420p[c];\
[a][b][c]concat=n=3:v=1:a=0[v]" -map "[v]" -an -c:v libx264 -crf 18 "$OUT/compare_1080p.mp4" && rep "compare_1080p.mp4 made. Watch it: does the avatar look as sharp and even as the stock clips?" || rep "WARNING: compare video failed (is broll.mp4 at least 6 s?)"
else rep "No broll.mp4 given, so no 720p-vs-1080p comparison video."; fi

# ---------- 7. summary ----------
rep ""; rep "=== TOTAL script time (setup and downloads included on the first run): $(secs "$T_ALL" "$(now)") s ==="
rep "GPU START TIME: this script cannot see it. Please note on the RunPod page how long it took from pressing Start until the terminal worked: ______ s"
rep "WATCH BY EYE (I cannot): 1) lips match YOUR language in clip10.mp4 and clip30.mp4  2) face looks like your photo, no drift in the last seconds of clip30.mp4  3) compare_1080p.mp4"
python3 - <<PY
import zipfile, glob, os
z = zipfile.ZipFile("$W/results.zip", "w", zipfile.ZIP_DEFLATED)
for f in ["$R"] + glob.glob("$OUT/*.mp4") + glob.glob("$OUT/sheet_*.png") + glob.glob("$OUT/*.log"):
    z.write(f, os.path.basename(f))
z.close(); print("results.zip written")
PY
rep ""; rep "RESULT: DONE. Download $W/results.zip (or report.txt + the mp4 files)."
