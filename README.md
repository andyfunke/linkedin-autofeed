# LinkedIn Autofeed

Autofeed puts recent posts from the LinkedIn profiles you choose into one newest-first feed in Chrome. Share this repository with your AI, set up a local checkout, and keep editing your copy as your needs change.

## Set up your copy

1. Clone this repository, then open the checkout in your AI coding tool. The `extension/` directory is ready to load as source. Chrome 120 or later and a signed-in LinkedIn session are the runtime requirements.
2. In the Chrome profile where you use LinkedIn, open `chrome://extensions`, turn on **Developer mode**, and choose **Load unpacked**. Select the `extension/` directory containing `manifest.json`.
3. Open **LinkedIn Autofeed** from Chrome’s Extensions menu. Paste a LinkedIn member profile URL and click **Follow**. Start with a profile that has a post you can see from the past seven days, then check that it appears in **Feed** and that **Open original post** leads to that post.
4. Use **Following** to find a profile by name or URL and see its last refresh result. Once your manual refresh works, you can set a daily local time under **Schedule**.

## Prompt for your AI

```text
Set up LinkedIn Autofeed from this repository in my local Chrome profile. Read
the setup steps and product assumptions in the README. Check the manifest and
explain which folder I should load into Chrome. I will handle LinkedIn sign-in
in the browser.

Help me verify one recent post end to end, including its text, date, media
when present, and original link. Use the Following view to diagnose missing
posts. Confirm a live refresh in my browser before saying the import works.

For later changes, edit my checkout directly and tell me which behavior
changed and what you checked. Keep the same unpacked extension path so I can
reload the extension and continue using my saved profiles. Follow the product
assumptions below unless I ask to change them.
```

## Product assumptions for your AI

- The list comes from member profile URLs the user adds. Merge their posts into one feed, newest first, with a seven-day window. **Unfollow** removes that person and their saved posts from Autofeed.
- Use the LinkedIn session already open in the same Chrome profile. Import reads the first batch rendered on each profile’s activity page, one profile at a time. Preserve a working manual refresh and keep the optional schedule to one run per local day while Chrome is open. Surface sign-in challenges, rate limits, and missing post links in the app.
- Keep followed profiles and captured posts in that Chrome profile. Use LinkedIn’s media URLs for images, a playable source or supported LinkedIn embed for video, and an original-post link when the video can’t play in the feed.
- Treat LinkedIn’s page layout as a dependency that can change. A fixture can verify the parser and app behavior. A signed-in live refresh verifies that the current site renders the expected cards and menus. Use a profile chosen for the test and keep captured post content and screenshots in the local workspace.
- The editable checkout is the distribution format. Make changes directly to the HTML, CSS, and JavaScript, then use **Reload** on the existing entry in `chrome://extensions` and reopen Autofeed.

## Where to make changes

| Area | Files |
| --- | --- |
| Chrome permissions and entry points | [manifest.json](extension/manifest.json) |
| LinkedIn activity cards, expanded text, media, and post links | [linkedin.js](extension/linkedin.js) |
| Refresh queue, scheduling, and Chrome storage | [background.js](extension/background.js) |
| Profile URL handling, deduplication, and feed ordering | [domain.js](extension/domain.js) |
| Feed, Following, and controls | [feed.html](extension/feed.html), [feed.css](extension/feed.css), [feed.js](extension/feed.js) |

If a profile shows posts that could not be read, check its activity page in the signed-in Chrome profile. Inspect the rendered card and its post menu before changing the importer. If you change the seven-day window, update the collector’s cutoff, the stored-post cutoff, and the feed labels together.
