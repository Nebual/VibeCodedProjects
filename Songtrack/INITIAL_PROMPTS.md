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
