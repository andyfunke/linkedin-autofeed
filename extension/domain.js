export const STATE_KEY = 'autofeed';
export const DAY = 24 * 60 * 60 * 1000;
export const LOOKBACK = 7 * DAY;
export const ORIGIN = 'https://www.linkedin.com';

export function normalizeProfile(input) {
  const raw = String(input ?? '').trim();
  if (!raw) throw new Error('Paste a LinkedIn profile URL.');
  let url;
  try {
    url = new URL(raw.includes('://') ? raw : `https://${raw}`);
  } catch {
    throw new Error('That URL could not be read.');
  }
  const path = url.pathname.match(/^\/in\/([^/]+)(?:\/recent-activity(?:\/[^/]+)?)?\/?$/i);
  if (!/^https?:$/.test(url.protocol) || !isLinkedIn(url) || !path) {
    throw new Error('Use a LinkedIn member profile URL, such as linkedin.com/in/your-profile/.');
  }
  let slug;
  try {
    slug = decodeURIComponent(path[1]).normalize('NFC');
  } catch {
    throw new Error('That profile URL contains an invalid character.');
  }
  if (!/^[\p{L}\p{M}\p{N}_\-]+$/u.test(slug) || slug.length > 150) {
    throw new Error('That LinkedIn profile URL has an invalid name.');
  }
  return { id: slug.toLowerCase(), url: `${ORIGIN}/in/${encodeURIComponent(slug)}/` };
}

function isLinkedIn(url) {
  return !url.username && !url.password && !url.port &&
    (url.hostname === 'linkedin.com' || url.hostname.endsWith('.linkedin.com'));
}

export function cleanPostUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !isLinkedIn(url)) return null;
    const pathname = decodeURIComponent(url.pathname);
    const urn = pathname.match(/^\/(?:embed\/)?feed\/update\/(urn:li:(?:activity|share|ugcPost):(\d{15,25}))\/?$/);
    if (urn) return { id: urn[2], url: `${ORIGIN}/feed/update/${urn[1]}/` };
    const post = pathname.match(/^\/posts\/(?!\.\.?\/)([^/\s?#]*-activity-(\d{15,25})-[^/\s?#]+)\/?$/);
    if (post) {
      return { id: post[2], url: `${ORIGIN}${url.pathname.replace(/\/$/, '')}/` };
    }
  } catch {
    return null;
  }
  return null;
}

export function mediaUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && !url.username && !url.password && !url.port &&
        (isLinkedIn(url) || url.hostname.endsWith('.licdn.com'))) return url.href;
  } catch {
    return null;
  }
  return null;
}

export function createState() {
  return {
    profiles: [],
    posts: [],
    pending: [],
    active: null,
    schedule: { enabled: false, time: '08:00', lastDay: null, lastRunAt: null, nextRunAt: null },
    notice: null,
  };
}

export function profileLabel(profile) {
  return profile.name || profile.id;
}

export function queueProfiles(state, ids) {
  const present = new Set(state.pending.map(job => job.subscription));
  if (state.active) present.add(state.active.subscription);
  for (const id of ids) {
    const profile = state.profiles.find(entry => entry.id === id);
    if (profile && !present.has(profile.subscription)) {
      state.pending.push({ id, subscription: profile.subscription, retries: 0 });
      present.add(profile.subscription);
    }
  }
}

export function unfollowProfile(state, id) {
  state.profiles = state.profiles.filter(profile => profile.id !== id);
  state.posts = state.posts.filter(post => post.profileId !== id);
  state.pending = state.pending.filter(job => job.id !== id);
  return state.active?.id === id ? state.active.tabId : null;
}

export function recentPosts(posts, now = Date.now()) {
  return posts.filter(post => post.publishedAt >= now - LOOKBACK)
    .sort((a, b) => b.publishedAt - a.publishedAt || b.id.localeCompare(a.id));
}

export function mergePosts(state, profile, incoming, now = Date.now()) {
  const byId = new Map(state.posts.map(post => [post.id, post]));
  const accepted = new Set();
  for (const raw of incoming) {
    if (!raw || typeof raw !== 'object') continue;
    const link = cleanPostUrl(raw.url);
    if (!link || !Number.isFinite(raw.publishedAt) || raw.publishedAt < now - LOOKBACK ||
        raw.publishedAt > now + 5 * 60_000 || typeof raw.text !== 'string') continue;
    const old = byId.get(link.id);
    if (old && old.profileId !== profile.id) continue;
    const media = cleanMedia(raw.media, link.id);
    if (!raw.text && !media.length) continue;
    byId.set(link.id, {
      ...link,
      profileId: profile.id,
      text: raw.text,
      media,
      publishedAt: old && raw.approximateDate ? old.publishedAt : raw.publishedAt,
      approximateDate: Boolean(raw.approximateDate) && (old?.approximateDate ?? true),
    });
    accepted.add(link.id);
  }
  state.posts = recentPosts([...byId.values()], now);
  return accepted.size;
}

function cleanMedia(items, postId) {
  if (!Array.isArray(items)) return [];
  const output = [];
  const seen = new Set();
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const url = mediaUrl(item.url);
    const poster = mediaUrl(item.poster);
    if (item.type === 'image' && url && !seen.has(url)) {
      output.push({ type: 'image', url, alt: String(item.alt || '').slice(0, 500) });
      seen.add(url);
    } else if (item.type === 'video') {
      const embed = cleanPostUrl(item.embedUrl);
      const embedUrl = embed?.id === postId && embed.url.startsWith(`${ORIGIN}/feed/update/`)
        ? embed.url.replace('/feed/update/', '/embed/feed/update/') : null;
      const key = url || embedUrl || poster || 'video';
      if (!seen.has(key)) {
        output.push({ type: 'video', url, poster, embedUrl });
        seen.add(key);
      }
    }
  }
  return output;
}

export function matchesProfile(profile, input) {
  const fold = text => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim();
  const query = fold(input);
  if (!query) return true;
  try {
    if (normalizeProfile(input).id === profile.id) return true;
  } catch {
    // A plain name or handle can be matched directly.
  }
  const haystack = fold(`${profileLabel(profile)} ${profile.id} ${profile.url}`);
  return query.split(/\s+/).every(word => haystack.includes(word));
}

export function localDay(date = new Date()) {
  return [date.getFullYear(), date.getMonth() + 1, date.getDate()]
    .map((part, index) => index ? String(part).padStart(2, '0') : String(part)).join('-');
}

export function validTime(time) {
  return typeof time === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time);
}

export function nextDailyRun(schedule, now = new Date()) {
  const [hour, minute] = schedule.time.split(':').map(Number);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute);
  if (today > now && schedule.lastDay !== localDay(now)) return today;
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, hour, minute);
}
