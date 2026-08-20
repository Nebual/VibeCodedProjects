# Initial Prompts

Verbatim record of the user's messages to AI:

---

## Initial request

Plan Building an app for Song recording, management, and editing.  
Ideally I'd like a web app (Nuxt v4, Tailwindcss v4, DaisyUI, node 24), if it doesn't have too many downsides compared to a native android app. Worth researching the limitations of web app for these use cases.  
It has Audio Recordings of piano songs, song tagging, saves audio to server as well as local (on phone). You can browse recordings and have basic playback controls.  
Auth uses Google Login.

Song Organization:
- Songs have names, descriptions, a key, time signature, personal rating out of 10, external link (eg. for Soundcloud)
- Custom Tags on songs (eg. haunting, high energy, vocals, Bill Evans, celtic, 4:4 time, songs for Louise), show a list of used tags sorted by recency so its quick to add more. Can filter the list of songs by tags
- Download song to mp3/ogg
- Share a link to a song (without recipient being logged in)
- Can organize songs into Albums, can select songs for the album and reorder them. Share an album link.

Nondestructive editing of songs, with:
- showing the waveforms as a visualization to help identify pauses/clicks/noise
- Buttons to trim beginning and ending of song including trimming noise, ideally autodetect the noise and let the user preview the seconds before/after the cut, before deleting. Sometimes the ending might be a long held final piano chord, we'd want to keep most of that.
- Buttons to try different approaches to filter out noise during the recording - for example, if there's a fan running the whole time, could that be cancelled out? If there's conversation going on, can those frequencies be reduced without compromising the music? May need research.
- crop out sections (eg. keep first 90 seconds and last 60 seconds, cutitng out the middle)

## Answers to clarifying-questions

**Where will this be hosted?**
Self-hosted on a Linux host, in a container. There's an existing nginx that'll handle tls termination, so all the container needs to do is expose a port to localhost and I'll handle pointing https://songtrack.nebtown.info at it. FFMpeg sounds good.

**How should songs and metadata be stored?**
SQLite + local disk (Recommended)

**Who uses the app?**
Open multi-user, but defer quotas/abuse considerations till later - it'll probably just be my friends and family using it.

**What device will you actually record on?**
Android phone (Chrome), Desktop / laptop browser

**With friends and family on the same instance, who can see whose songs?**
Private per user (Recommended)

**Should anyone with a Google account be able to sign up, or is entry gated?**
I will be the admin. Let's have an admin approval ui, with unapproved users allowed 10 recordings, and an admin toggle to turn off signups. Also, allow the admin to impersonate a user (see their view)

**How are you actually miking the piano?**
Phone's built-in mic, Not sure yet / varies

**Do you already have a backlog of recordings to bring in?**
Yes — a folder of files to import

Allow admin to edit too, not just readonly.  
Don't show the "max 10 songs" banner until the user is at 8+ songs.  
The /s/ and /a/ links should include #song-name at their end, as a visual indicator.

The recording UI should be fairly focused - big Record/Pause/Resume button, a duration, a little waveform of the last 10 seconds, a Save button that pauses and saves, asking for a name and optional tags.  
A small cancel button, which asks for confirmation before exiting out of the recording without saving.  
While recording is paused, its possible to playback the recording and seek around, which reveals a 'seek to end' button.  
Disable the 'resume recording' while the playback is running.  
Its possible to resume recording midway through a seeked song, which records a new segment that will replace (non-destructively, ideally) what its overtop of, though show a little warning below the Record button if it'll override existing time.

Lets research more about denoising techniques / alternatives with tradeoffs.  
6A and B suggest I should advise users to record 3 seconds of ambience before starting to play, to provide a sample for the filter of their environmental noise, would that work well? 6D is interesting and something I'll likely add later in a Phase 6.

Build the plan.

## UI feedback round 1

Minor UI feedback:
- the icons look bad, lets install mui or heroicons. (this) image shows the current recording screen.
- Lets vertically center the pause/recording main button, make it bigger, improve the icon and take out the word 'Pause'.
- Lets allow entering a name on that page (optionally) while paused, which will then pass through to the Save.
- Also seeking doesn't work while playing in the /record page, and playback stops when it finishes a segment (though maybe that'll be fixed in a later phase).
- Can the recording icon's central dot be Red (keeping the main background primary is good)
- The Record page is full page height + additional space for the navbar, which leads to scrolling.
- The seek playback bar on it isn't full width. Seeking during active playback doesn't work.
- Testing on a real phone, recording survives the screen going off and switching to other apps, but it is silenced while looking at the lock screen. I noticed in one screen off event, it didn't go to lock screen when I woke it, so it was seamless recording. In another, it was seamless until I awoke it to a lock screen. Can we attempt to prevent (auto) locking?
- Lets have the start recording button, look like a recording dot, when the recording is paused. Currently it looks like it'll play, which is misleading.

Then continue with next phase

## Feedback round 2

I added some sample recordings from my phone in @samples/UpliftingClouds.m4a (this one should have 1 second trimmed off the start, and about 7 seconds off the end). @"samples/Wondering if Theres Something Here.m4a" should have 5s off the start and 10s off the end. Useful for when we get to that stage of testing the filters/etc

The edit page won't seem to load for me. Clientside nav does nothing, and refreshing the /edit or /songs/x urls shows
```
Cannot read properties of undefined (reading 'origin')\n" +
  'at ComputedRefImpl.fn (/home/nebual/Songtrack/app/pages/songs/[id].vue:80:24)\n' +
```

I also see an error 'Failed to resolve component: WaveformCanvas' , and indeed see no waveforms. I think it needs to move out of that recorder/ folder, or be accessed differently

Ui tweak: when writing in tags, if Save is pressed while there's something in the tag search box, create a tag named that input value.
When hitting the 'Copy' (share link) button, make it switch to say 'Copied!'

Edit page still doesn't load (well it looks exactly the same as /songs/:id).
Canvas still looks blank during recording.

Having some tests (e2e, vitest) in the repo would be good

Edit page loads now. I can't drag on the timeline where its already green, so I can't add a red (remove) zone to cut out a middle section. Dragging the edges of the green (keep) zone works, and dragging a red zone from outside the green in and hitting apply works.

## Feedback round 3

The audio recording is currently way too quiet on multiple devices. Is there some sort of microphone gain we need to turn up?  
I'm leaning away from autoGain then - but what can we do about the in-browser playback previews, before the finalize step? Is there anything in-browser we can do about that, or is the loudnorm-like ffmpeg approach fast enough that we could do it for the preview?

The gain boosting/level normalize in the @app/pages/songs/[id]/edit.vue flow should probably be applied to all playbacks on the page, as listening to a non-boosted version isn't helpful to the user. Lets allow the user to adjust the target level.  
Lets allow the user to customize where the ambience sample is, perhaps add a 'select ambience' button when Noise Reduction is enabled, that allows dragging an area.  
When applying noise reduction, does it make sense to do the gain boost before the noise reduction step? I'm currently finding the noise reduction not very good (it either does little, or at higher strengths affects the music), so I'm just guessing there.  
When using 'Listen to whats removed' or 'Preview original' or 'Preview with settings', there needs to be playback controls - seek and pause, which should un-disable the buttons and allow making tweaks without having to hear the whole track.  
Lets remove the footer playback controls when in the Edit page, its confusing.

When hitting 'Preview start cut', its not clear where the cut is, as it keeps playing past the cut. Should also be able to press it again to stop.

When I first start recording, there's often a loud click as the microphone is first captured. Interestingly, if I pause and resume a recording, there's no click, so its to do with the microphone not being primed, not the tap of the button. Can we discard the first 400ms of microphone if we just started using the microphone?

The marker on the seek bar is in the wrong place if there's not enough audio to pad the sides. If we only trim 1 second off the start, I expect the marker to be at the 1 second mark. Also can we add an audible click at the cut mark in the preview.

The noise reduction doesn't seem to behave any differently whether I select an ambience sample or not, either way it doesn't work well.

# To be sent:

Ambience sample still doesn't seem to have an effect on the previews.

The recording page preview and the edit page's top preview both are still too quiet - on one device they're tolerable (but still 30% quieter than the final -16 LUFS), on another they're better than initially but still too quiet (75% quieter than the final -16 LUFS).

Timing wise, lets replace the '5s ambience lead-in' with a suggestion to capture 5s of ambience at the end of the recording. The suggestion can show above the 'Name this recording' input, in small text, when the seek is at the end.

