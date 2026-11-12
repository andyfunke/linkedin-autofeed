import {
  STATE_KEY, createState, localDay, matchesProfile, normalizeProfile, profileLabel, recentPosts,
} from './domain.js';

const $ = id => document.getElementById(id);
const dateFormat = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
const timeFormat = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
let state = createState();
let feedVersion;

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function externalLink(text, href, className) {
  const link = node('a', className, text);
  link.href = href;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  return link;
}

function when(timestamp) {
  const date = new Date(timestamp);
  const day = localDay(date) === localDay() ? 'Today' : dateFormat.format(date);
  return `${day} at ${timeFormat.format(date)}`;
}

function plural(count, noun) {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

function status(element, text, error = false) {
  element.textContent = text;
  element.hidden = !text;
  element.classList.toggle('error', error);
}

async function action(type, data = {}) {
  const result = await chrome.runtime.sendMessage({ type, ...data });
  if (!result?.ok) throw new Error(result?.error || 'Autofeed is unavailable. Reload this tab and try again.');
  return result;
}

function avatar(profile) {
  const initials = profileLabel(profile).split(/[\s_-]+/).slice(0, 2)
    .map(part => Array.from(part)[0]?.toUpperCase() || '').join('');
  const mark = node('span', 'avatar', initials);
  mark.setAttribute('aria-hidden', 'true');
  return mark;
}

function profileButton(type, text, profile, className) {
  const button = node('button', className, text);
  button.type = 'button';
  button.dataset.action = type;
  button.dataset.profile = profile.id;
  button.setAttribute('aria-label', `${text} ${profileLabel(profile)}`);
  return button;
}

function videoFallback(media, url) {
  const container = node('div', 'media-status');
  if (!media.embedUrl) {
    container.append(externalLink('Watch the video on LinkedIn', url));
    return container;
  }
  const play = node('button', 'button button-subtle', 'Show video');
  play.type = 'button';
  play.addEventListener('click', () => {
    const frame = node('iframe');
    frame.src = media.embedUrl;
    frame.title = 'Video from LinkedIn';
    frame.allow = 'fullscreen; picture-in-picture; encrypted-media';
    frame.allowFullscreen = true;
    container.replaceWith(frame);
  }, { once: true });
  container.append(play);
  return container;
}

function renderMedia(post) {
  const wrapper = node('div', 'post-media');
  for (const media of post.media) {
    if (media.type === 'image') {
      const image = node('img');
      image.alt = media.alt && media.alt !== 'View image' ? media.alt : 'Image attached to the LinkedIn post';
      image.loading = 'lazy';
      image.decoding = 'async';
      image.addEventListener('error', () => {
        const fallback = node('div', 'media-status');
        fallback.append(externalLink('View the image on LinkedIn', post.url));
        image.replaceWith(fallback);
      }, { once: true });
      image.src = media.url;
      wrapper.append(image);
    } else if (media.type === 'video' && media.url) {
      const video = node('video');
      video.controls = true;
      video.preload = 'none';
      video.playsInline = true;
      if (media.poster) video.poster = media.poster;
      video.addEventListener('error', () => video.replaceWith(videoFallback(media, post.url)), { once: true });
      video.src = media.url;
      wrapper.append(video);
    } else if (media.type === 'video') {
      wrapper.append(videoFallback(media, post.url));
    }
  }
  return wrapper;
}

function renderPost(post, profile) {
  const article = node('article', 'panel post');
  article.dataset.postId = post.id;
  const header = node('header', 'post-header');
  const byline = node('div', 'post-byline');
  const time = node('time', '', post.approximateDate ? `About ${when(post.publishedAt).toLowerCase()}` : when(post.publishedAt));
  time.dateTime = new Date(post.publishedAt).toISOString();
  byline.append(externalLink(profileLabel(profile), profile.url, 'author'), time);
  header.append(avatar(profile), byline, profileButton('unfollow', 'Unfollow', profile, 'button-link'));
  article.append(header);
  if (post.text) article.append(node('div', 'post-copy', post.text));
  if (post.media.length) article.append(renderMedia(post));
  const footer = node('footer', 'post-footer');
  footer.append(externalLink('Open original post ↗', post.url));
  article.append(footer);
  return article;
}

function emptyState(title, detail) {
  const empty = node('div', 'panel empty');
  empty.append(node('h2', '', title), node('p', 'muted', detail));
  return empty;
}

function renderFeed(posts, profiles, busy) {
  const list = $('feed-list');
  if (posts.length) {
    const version = JSON.stringify([posts, posts.map(post => profileLabel(profiles.get(post.profileId))), localDay()]);
    if (version === feedVersion) return;
    feedVersion = version;
    list.replaceChildren(...posts.map(post => renderPost(post, profiles.get(post.profileId))));
    return;
  }
  let title;
  let detail;
  if (!profiles.size) {
    title = 'Follow your first profile';
    detail = 'Paste a LinkedIn profile URL above to start your feed.';
  } else if (busy) {
    title = 'Reading LinkedIn activity';
    detail = 'Posts will appear as each profile is checked.';
  } else if ([...profiles.values()].some(profile => profile.lastResult?.error || profile.lastResult?.missed)) {
    title = 'Some activity could not be read';
    detail = 'Check the Following view for details, then refresh.';
  } else {
    title = 'No posts in the past 7 days';
    detail = 'Refresh to check for new posts.';
  }
  if (feedVersion === title) return;
  feedVersion = title;
  list.replaceChildren(emptyState(title, detail));
}

function profileStatus(profile) {
  if (state.active?.subscription === profile.subscription) return 'Refreshing…';
  if (state.pending.some(job => job.subscription === profile.subscription)) return 'Queued';
  const result = profile.lastResult;
  if (!result) return 'Waiting for first refresh';
  if (result.error) return result.error;
  const problems = [];
  if (result.missingLinks) problems.push(`${plural(result.missingLinks, 'post')} without a link`);
  const unread = result.missed - (result.missingLinks || 0);
  if (unread > 0) problems.push(`${unread} could not be read`);
  const missed = problems.length ? ` · ${problems.join(' · ')}` : '';
  return `Checked ${when(result.checkedAt).toLowerCase()} · ${plural(result.postCount, 'post')}${missed}`;
}

function renderFollowing() {
  const list = $('following-list');
  const query = $('profile-search').value;
  const profiles = state.profiles.filter(profile => matchesProfile(profile, query))
    .sort((a, b) => profileLabel(a).localeCompare(profileLabel(b)));
  if (!profiles.length) {
    list.replaceChildren(state.profiles.length
      ? emptyState('No matching profiles', 'Try another name or profile URL.')
      : emptyState('You aren’t following anyone yet', 'Add a LinkedIn profile using the field above.'));
    return;
  }
  list.replaceChildren(...profiles.map(profile => {
    const row = node('article', 'panel person');
    const detail = node('div', 'person-details');
    const health = node('p', 'person-status', profileStatus(profile));
    if (profile.lastResult?.error && !state.pending.some(job => job.id === profile.id) && state.active?.id !== profile.id) {
      health.classList.add('profile-error');
    }
    detail.append(externalLink(profileLabel(profile), profile.url, 'author'),
      externalLink(new URL(profile.url).pathname, profile.url, 'person-url'), health);
    const controls = node('div', 'person-actions');
    const refresh = profileButton('refresh', 'Refresh', profile, 'button button-subtle');
    refresh.disabled = state.active?.subscription === profile.subscription || state.pending.some(job => job.subscription === profile.subscription);
    controls.append(refresh, profileButton('unfollow', 'Unfollow', profile, 'button-link'));
    row.append(avatar(profile), detail, controls);
    return row;
  }));
}

function render() {
  const following = location.hash === '#following';
  $('feed-view').hidden = following;
  $('following-view').hidden = !following;
  $('feed-tab').toggleAttribute('aria-current', !following);
  $('following-tab').toggleAttribute('aria-current', following);
  (following ? $('following-tab') : $('feed-tab')).setAttribute('aria-current', 'page');
  $('page-title').textContent = following ? 'Following' : 'Your feed';

  const profiles = new Map(state.profiles.map(profile => [profile.id, profile]));
  const posts = recentPosts(state.posts).filter(post => profiles.has(post.profileId));
  const active = state.active && profiles.get(state.active.id);
  const busy = Boolean(active || state.pending.length);
  $('page-details').textContent = following ? plural(profiles.size, 'profile')
    : `Past 7 days · ${plural(posts.length, 'post')} · ${plural(profiles.size, 'profile')}`;
  $('refresh').disabled = !profiles.size || busy;
  $('refresh').textContent = busy ? 'Refreshing…' : 'Refresh now';
  $('schedule-open').dataset.enabled = String(state.schedule.enabled);
  $('schedule-open').textContent = state.schedule.enabled ? 'Schedule on' : 'Schedule';

  const queued = state.pending.length;
  const activity = active ? `Refreshing ${profileLabel(active)}${queued ? ` · ${plural(queued, 'profile')} queued` : ''}`
    : queued ? `${plural(queued, 'profile')} queued for refresh` : '';
  status($('refresh-status'), activity);
  const problems = state.profiles.filter(profile => profile.lastResult?.error || profile.lastResult?.missed).length;
  status($('refresh-notice'), state.notice || (!busy && problems ? `${plural(problems, 'profile')} with incomplete activity. See Following for details.` : ''));
  if (following) renderFollowing();
  else renderFeed(posts, profiles, busy);
}

$('follow-form').addEventListener('submit', async event => {
  event.preventDefault();
  const field = $('profile-url');
  const button = $('follow-submit');
  const message = $('follow-message');
  const input = field.value;
  button.disabled = true;
  try {
    const profile = normalizeProfile(input);
    const result = await action('follow', { url: profile.url });
    if (field.value === input) field.value = '';
    status(message, result.added ? 'Profile added. Checking LinkedIn activity.' : 'You already follow this profile.');
  } catch (error) {
    status(message, error.message, true);
  } finally {
    button.disabled = false;
  }
});

$('refresh').addEventListener('click', async () => {
  try {
    status($('follow-message'), '');
    await action('refresh');
  } catch (error) {
    status($('follow-message'), error.message, true);
  }
});

document.addEventListener('click', async event => {
  const button = event.target.closest('button[data-profile]');
  if (!button) return;
  const profile = state.profiles.find(entry => entry.id === button.dataset.profile);
  if (!profile) return;
  button.disabled = true;
  try {
    await action(button.dataset.action, { id: profile.id });
    if (button.dataset.action === 'unfollow') status($('follow-message'), `Unfollowed ${profileLabel(profile)}.`);
  } catch (error) {
    button.disabled = false;
    status($('follow-message'), error.message, true);
  }
});

const scheduleDialog = $('schedule-dialog');
const scheduleEnabled = $('schedule-enabled');
const scheduleTime = $('schedule-time');
$('schedule-open').addEventListener('click', () => {
  scheduleEnabled.checked = state.schedule.enabled;
  scheduleTime.value = state.schedule.time;
  scheduleTime.disabled = !scheduleEnabled.checked;
  status($('schedule-error'), '');
  $('schedule-details').textContent = state.schedule.nextRunAt
    ? `Next refresh ${when(state.schedule.nextRunAt).toLowerCase()} while Chrome is open and signed in to LinkedIn.`
    : 'Runs while Chrome is open and signed in to LinkedIn.';
  scheduleDialog.showModal();
});
$('schedule-cancel').addEventListener('click', () => scheduleDialog.close());
scheduleEnabled.addEventListener('change', () => { scheduleTime.disabled = !scheduleEnabled.checked; });
$('schedule-form').addEventListener('submit', async event => {
  event.preventDefault();
  $('schedule-save').disabled = true;
  try {
    await action('schedule', { enabled: scheduleEnabled.checked, time: scheduleTime.value });
    scheduleDialog.close();
  } catch (error) {
    status($('schedule-error'), error.message, true);
  } finally {
    $('schedule-save').disabled = false;
  }
});

$('profile-search').addEventListener('input', renderFollowing);
window.addEventListener('hashchange', render);
let receivedState = false;
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes[STATE_KEY]) return;
  receivedState = true;
  state = changes[STATE_KEY].newValue || createState();
  render();
});
const stored = await chrome.storage.local.get(STATE_KEY);
if (!receivedState) state = stored[STATE_KEY] || createState();
render();
setInterval(render, 60_000);
void action('open').catch(error => status($('follow-message'), error.message, true));
