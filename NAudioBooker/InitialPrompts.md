# Initial Prompts

Prompts sent to Claude Code while building NAudioBooker, verbatim .

---

## 1. 2026-08-01 22:01 UTC

```text
Before we start, I want to plan this a bit.
I want to make a website that can turn an epub into an audiobook (a collection of mp3 files by chapter with appropriate metadata). What are our options for text-to-speech? List them with advantages/tradeoffs. I'm considering something that uses a local AI model running on my GPU, if that improves quality. Ideally it'd run on a Linux host with a 4gb AMD RX 580, but I also have a Windows host with a 3070 (8gb) if the extra power helps.
```

## 8. 2026-08-02 02:51 UTC

```text
Can you output the audio samples somewhere I can access (eg. in the data folder) so I can review them, and highlight which had words count mismatches? Then proceed with phase 4
```

## 11. 2026-08-02 05:49 UTC

```text
Dockerfile.gpu is failing to build saying none of the python3.12 packages exist - its possible the ubuntu22.04 cuda image doesn't have them. Can we fix, maybe by adding a ppa
```

## 12. 2026-08-02 06:48 UTC

```text
I ran the gpu docker and curl and saw: 
curl http://localhost:8001/node/health
{"available":false,"detail":"missing model files: kokoro-v1.0.onnx, voices-v1.0.bin","backend":"kokoro","model_version":"kokoro-1.0/kokoro-v1.0","sample_rate":24000,"max_chars":350,"provider":null,"authenticated":true}
```

## 14. 2026-08-02 07:11 UTC

```text
Set 2026_08_02_00-03-23_firefox.png as the favicon.
Healthcheck on the gpu node looks good, but the Linux Host's web view shows " No voices available. The TTS backend could not start — check that the model files are present. ". I did run the fetch-models.sh script on the Linux Host so I see the models in models/, and I did set the Linux host's .env
```

## 15. 2026-08-02 07:23 UTC

```text
The worker docker container is taking 10 seconds+ to stop, and thus is probably not shutting down cleanly.
```

## 16. 2026-08-02 07:30 UTC

```text
Curling /health on the Linux host shows:
{"status":"ok","version":"0.1.0","role":"api","tts_backend":"kokoro","deps":{"ffmpeg":true,"espeak_ng":true},"tts":{"configured":"kokoro","active":"kokoro","available":true,"detail":"kokoro-v1.0.onnx (loaded)","provider":"CPUExecutionProvider"}}

curl http://192.168.0.160:8001/node/health (the Windows host) from the linux Host shows:
{"available":true,"detail":"kokoro-v1.0.onnx (loaded)","backend":"kokoro","model_version":"kokoro-1.0/kokoro-v1.0","sample_rate":24000,"max_chars":350,"provider":"CUDAExecutionProvider","authenticated":true}

The linux web still seems to be using its CPU local fallback - the only activity I see in the Windows logs are my own curl tests.
```

## 17. 2026-08-02 07:40 UTC

```text
Lets hide the non-English voices (keep british and american).

Can you make the benchmark script work for gpu? I want to see the RTF
```

## 18. 2026-08-02 08:03 UTC

```text
I'm seeing 45x RTF, nice!

Moving onto the next phase: heavier models. It might be nice to let the user choose a model similar to the Voice selector - the existing voices are all Kokoro, and other models seem to have other voice options. Chatterbox has voice cloning, so perhaps let the user upload a voice clip to use (and have them name it) and then its an added voice option. If Chatterbox is slower than Kokoro, which sounds likely, it may only be an option when doing remote synthesizing on the GPU host -- thats ok, lets just ensure the UI communicates that.
Before we start, are there other options than Chatterbox to consider? Provide a comparison.
```

## 19. 2026-08-02 08:18 UTC

```text
Is that Chatterbox v2? How about OmniVoice?
```

## 20. 2026-08-02 08:23 UTC

```text
If I'm solely interested in English, is Chatterbox Multilingual v3 the best choice (due to it being newer?) or is the 'Original' mentioned still from 2026 and better for being focused on English?

I'm leaning OmniVoice + Chatterbox, initially without the drift checks while I compare how they sound in samples/speed.
```

## 21. 2026-08-02 08:28 UTC

```text
Sure lets proceed with those 2.

Skip running cpu benchmarks for now, just update the benchmark script so I can run it on the GPU later for each model.

Lets expand the voice sample UI - let the user enter a custom phrase (and provide a dropdown of additional phrases, including the first 2 sentances from the current book's chapter 1). Also have choice of voice be remembered in local storage.

Any clarifying questions I can answer?
```

## 22. 2026-08-02 08:35 UTC

```text
lets just do Chatterbox Original and Omnivoice for now.
```

## 23. 2026-08-02 08:48 UTC

```text
The voice cloning sounds great.

For needing its own venv, does that mean running 2 docker containers for the Windows host, or just 2 venvs within 1?
```

## 24. 2026-08-02 08:53 UTC

```text
Can you make each gpu container's process auto unload from the gpu (freeing vram) after 60 seconds of inactivity? Maybe also have the Linux host's api send an 'unload' call to the other two nodes (if their host, ignoring port, matches) when trying to start a remote worker, to avoid running out of VRAM.

I think do all 4, afterwards when the containers both work I'll run the benchmark and then we can update the hints based on that.
```

## 27. 2026-08-02 09:45 UTC

```text
Can you copy the benchmark script into the gpu dockerfiles for omnivoice/chatterbox. Also the uv run, when I try it in their containers, seems to uninstall chatterbox-tts (possibly because it isn't in their pyproject.toml). Running uv with --no-sync after manually installing it, I was able to get omnivoice to bench at:

[transformers] You seem to be using the pipelines sequentially on GPU. In order to maximize efficiency please use a dataset
           omnivoice    CUDA    -    419.0s   119.6s   3.50x     5.09 h

however chatterbox failed, after downloading models, with:
 chatterbox-original   unavailable: could not load Chatterbox: 'NoneType' object is not callable
```

## 28. 2026-08-02 09:59 UTC

```text
Here's the benchmarks for Chatterbox:
 chatterbox-original    CUDA    -    457.7s   211.8s   2.16x     8.25 h
------------------------------------------------------------------------
best: chatterbox-original on CUDA at 2.16x real time
  a 160,404-word book renders in about 8.25 hours
  per-chunk latency: median 5409 ms, max 6013 ms

I think we can proceed
```

## 29. 2026-08-02 10:13 UTC

```text
Are all the planned tasks done?
```

## 30. 2026-08-02 10:21 UTC

```text
When showing a preview from the book for the Narration choices, skip over really short sentances (that are often just the
  title of the chapter), and show multiple chapters - the first 3 that are selected would be good.
```

## 32. 2026-08-02 10:46 UTC

```text
When trying to run the Preview or Render from the Linux host, of either Chatterbox or Omnivoice, it looks like its still trying to run through Linux kokoro -- and getting confused by the custom uploaded voice not being found in Kokoro.
Looking at logs, I see the Windows GPU host's chatterbox and omnivoice isntances are getting /node/unload POST's, so clearly Linux Host is talking to them, it just isn't sending the request to the right spot - like its ignoring the Model dropdown.
```

## 33. 2026-08-02 11:06 UTC

```text
Trying to preview with Chatterbox is running into "node unavailable: {"detail":"could not load Chatterbox: 'NoneType' object is not callable"}"
Trying to preview with Omnivoice got farther, and I saw it load the model, but then said "node returned 400: {"detail":"OmniVoice failed on 239 chars: Failed to find C compiler. Please specify via CC environment variable or set triton.knobs.build.impl."}"
```

## 34. 2026-08-02 11:23 UTC

```text
Lets add a Download button to the Preview. Lets cache them too (like renders do), so its quicker to compare between voices/models.
```

## 35. 2026-08-02 11:31 UTC

```text
Chatterbox has 2 settings that influence the voice - lets expose those. Here's their explanation of them:

    The default settings (exaggeration=0.5, cfg_weight=0.5) work well for most prompts across all languages.
    If the reference speaker has a fast speaking style, lowering cfg_weight to around 0.3 can improve pacing.

Expressive or Dramatic Speech:

    Try lower cfg_weight values (e.g. ~0.3) and increase exaggeration to around 0.7 or higher.
    Higher exaggeration tends to speed up speech; reducing cfg_weight helps compensate with slower, more deliberate pacing.
```

## 36. 2026-08-02 11:47 UTC

```text
UI Feedback about this image: "C:\Users\ben11\Documents\Claude Experiments\NAudioBooker\2026_08_02_04-44-42_firefox.png" - make those 2 alerts alert-soft, the sizing/spacing could be cleaner (eg. beside the sliders needs more padding / alignment). Preview button should go in the bottom left below the text its previewing (the character warning can move right a bit)
```
