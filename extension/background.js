import {
  ORIGIN, STATE_KEY, createState, localDay, mergePosts, nextDailyRun,
  normalizeProfile, queueProfiles, recentPosts, unfollowProfile, validTime,
} from './domain.js';
import { collectActivity } from './linkedin.js';

const DAILY_ALARM = 'autofeed-daily';
const RECOVERY_ALARM = 'autofeed-recovery';
const TAB_PREFIX = 'autofeed-tab-';
const FEED_URL = chrome.runtime.getURL('feed.html');

let writes = Promise.resolve();
let initialization;
let running;

async function readState() {
  return (await chrome.storage.local.get(STATE_KEY))[STATE_KEY] || createState();
}

function changeState(update) {
  const task = writes.then(async () => {
    const state = await readState();
    const result = await update(state);
    state.posts = recentPosts(state.posts);
    await chrome.storage.local.set({ [STATE_KEY]: state });
    return result;
  });
  writes = task.catch(() => {});
  return task;
}

function findSubscription(state, job) {
  return state.profiles.find(profile => profile.id === job.id && profile.subscription === job.subscription);
}

async function closeOwnedTab(id) {
  if (!Number.isInteger(id)) return;
  const key = `${TAB_PREFIX}${id}`;
  if (!(await chrome.storage.session.get(key))[key]) return;
  await chrome.tabs.remove(id).catch(() => {});
  await chrome.storage.session.remove(key);
}

async function recoverInterruptedJob() {
  const temporary = await chrome.storage.session.get(null);
  for (const key of Object.keys(temporary).filter(key => key.startsWith(TAB_PREFIX))) {
    await closeOwnedTab(Number(key.slice(TAB_PREFIX.length)));
  }
  await changeState(state => {
    const job = state.active;
    if (!job) return;
    state.active = null;
    const profile = findSubscription(state, job);
    if (!profile) return;
    if (job.retries < 1) {
      state.pending.unshift({ id: job.id, subscription: job.subscription, retries: job.retries + 1 });
    } else {
      profile.lastResult = { checkedAt: Date.now(), error: 'Refresh was interrupted. Try refreshing again.' };
    }
  });
}

async function programDailyAlarm(schedule, keepExisting = false) {
  if (!schedule.enabled) {
    await chrome.alarms.clear(DAILY_ALARM);
    schedule.nextRunAt = null;
    return;
  }
  const existing = keepExisting ? await chrome.alarms.get(DAILY_ALARM) : null;
  schedule.nextRunAt = existing?.scheduledTime ?? nextDailyRun(schedule).getTime();
  if (!existing) await chrome.alarms.create(DAILY_ALARM, { when: schedule.nextRunAt });
}

function initialize() {
  initialization ||= (async () => {
    await recoverInterruptedJob();
    await changeState(state => programDailyAlarm(state.schedule, true));
  })().catch(error => {
    initialization = undefined;
    throw error;
  });
  return initialization;
}

function tabNavigation(id) {
  return new Promise((resolve, reject) => {
    const end = (error, tab) => {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(updated);
      chrome.tabs.onRemoved.removeListener(removed);
      if (error) reject(error);
      else resolve(tab);
    };
    const updated = (tabId, change, tab) => {
      if (tabId === id && tab.status === 'complete' && tab.url && tab.url !== 'about:blank') end(null, tab);
    };
    const removed = tabId => {
      if (tabId === id) end(new Error('The activity tab closed.'));
    };
    const timer = setTimeout(() => end(new Error('LinkedIn took too long to load.')), 15_000);
    chrome.tabs.onUpdated.addListener(updated);
    chrome.tabs.onRemoved.addListener(removed);
    chrome.tabs.get(id).then(tab => updated(id, null, tab), error => end(error));
  });
}

function limitTime(work, duration, message) {
  let timer;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), duration);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

async function scrape(job, profile) {
  let id;
  try {
    const url = new URL('recent-activity/all/', profile.url).href;
    const tab = await chrome.tabs.create({ url, active: false });
    id = tab.id;
    await chrome.storage.session.set({ [`${TAB_PREFIX}${id}`]: true });
    const retained = await changeState(state => {
      if (!findSubscription(state, job)) return false;
      state.active.tabId = id;
      return true;
    });
    if (!retained) return { status: 'cancelled' };
    const loaded = await tabNavigation(id);
    const loadedUrl = new URL(loaded.url);
    if (loadedUrl.origin !== ORIGIN) return { status: 'unavailable' };
    const [injection] = await limitTime(chrome.scripting.executeScript({
      target: { tabId: id },
      world: 'MAIN',
      func: collectActivity,
      args: [profile.url],
    }), 23_000, 'LinkedIn took too long to return the activity.');
    return injection?.result || { status: 'unavailable' };
  } catch (error) {
    return { status: 'error', error: error.message || 'The activity page could not be read.' };
  } finally {
    await closeOwnedTab(id);
  }
}

function nextJob() {
  return changeState(state => {
    if (state.active) return null;
    while (state.pending.length) {
      const job = state.pending.shift();
      const profile = findSubscription(state, job);
      if (profile) {
        state.active = { ...job, tabId: null };
        return { job, profile };
      }
    }
    return null;
  });
}

async function completeJob(job, result) {
  const checkedAt = Date.now();
  await changeState(state => {
    state.active = null;
    const profile = findSubscription(state, job);
    if (!profile || result.status === 'cancelled') return;
    if (result.status === 'ok' && Array.isArray(result.posts)) {
      if (typeof result.name === 'string' && result.name.trim()) profile.name = result.name.trim().slice(0, 200);
      const postCount = mergePosts(state, profile, result.posts, checkedAt);
      profile.lastResult = {
        checkedAt, postCount,
        missed: Math.max(0, Number(result.missed) || 0) + Math.max(0, result.posts.length - postCount),
        missingLinks: Math.max(0, Number(result.missingLinks) || 0),
      };
      return;
    }
    const errors = {
      'sign-in': 'Open LinkedIn, sign in, then refresh.',
      'rate-limit': 'LinkedIn asked to slow down. Try again later.',
      unavailable: 'The activity page could not be read. Check the profile in LinkedIn.',
    };
    const error = Object.hasOwn(errors, result.status) ? errors[result.status] : String(result.error || errors.unavailable).slice(0, 240);
    profile.lastResult = { checkedAt, error };
    if (result.status === 'sign-in' || result.status === 'rate-limit') {
      state.notice = error;
      state.pending = [];
    }
  });
}

async function runQueue() {
  let entry = await nextJob();
  while (entry) {
    await chrome.alarms.create(RECOVERY_ALARM, { delayInMinutes: 1 });
    const { job, profile } = entry;
    await completeJob(job, await scrape(job, profile));
    entry = await nextJob();
  }
  await chrome.alarms.clear(RECOVERY_ALARM);
}

function startQueue() {
  if (running) return;
  running = runQueue().catch(report).finally(() => {
    running = undefined;
    // An add or refresh can arrive while an empty queue is winding down.
    void readState().then(state => {
      if (state.pending.length && !state.active) startQueue();
    }).catch(report);
  });
}

async function handleMessage(message) {
  await initialize();
  if (message.type === 'follow') {
    const input = normalizeProfile(message.url);
    const added = await changeState(state => {
      if (state.profiles.some(profile => profile.id === input.id)) return false;
      state.profiles.push({ ...input, subscription: crypto.randomUUID(), name: '', followedAt: Date.now(), lastResult: null });
      state.notice = null;
      queueProfiles(state, [input.id]);
      return true;
    });
    startQueue();
    return { added };
  }
  if (message.type === 'unfollow') {
    const tabId = await changeState(state => unfollowProfile(state, message.id));
    await closeOwnedTab(tabId);
    return {};
  }
  if (message.type === 'refresh') {
    await changeState(state => {
      state.notice = null;
      queueProfiles(state, message.id ? [message.id] : state.profiles.map(profile => profile.id));
    });
    startQueue();
    return {};
  }
  if (message.type === 'schedule') {
    if (!validTime(message.time)) throw new Error('Choose a valid refresh time.');
    await changeState(async state => {
      state.schedule.enabled = message.enabled === true;
      state.schedule.time = message.time;
      await programDailyAlarm(state.schedule);
    });
    return {};
  }
  if (message.type === 'open') {
    startQueue();
    return {};
  }
  throw new Error('That action is unavailable.');
}

async function onAlarm(alarm) {
  await initialize();
  if (alarm.name === RECOVERY_ALARM) {
    if (running) return;
    await recoverInterruptedJob();
  } else if (alarm.name === DAILY_ALARM) {
    await changeState(async state => {
      const schedule = state.schedule;
      const now = new Date();
      if (schedule.enabled && schedule.lastDay !== localDay(now) && state.profiles.length) {
        schedule.lastDay = localDay(now);
        schedule.lastRunAt = now.getTime();
        state.notice = null;
        queueProfiles(state, state.profiles.map(profile => profile.id));
      }
      await programDailyAlarm(schedule);
    });
  } else {
    return;
  }
  startQueue();
}

async function openFeed() {
  const tabs = await chrome.tabs.query({ url: FEED_URL });
  if (tabs.length) {
    await chrome.tabs.update(tabs[0].id, { active: true });
    await chrome.windows.update(tabs[0].windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url: FEED_URL });
  }
}

function report(error) {
  console.error('LinkedIn Autofeed:', error);
}

chrome.action.onClicked.addListener(() => { void openFeed().catch(report); });
chrome.runtime.onInstalled.addListener(() => { void initialize().then(startQueue).catch(report); });
chrome.runtime.onStartup.addListener(() => { void initialize().then(startQueue).catch(report); });
chrome.alarms.onAlarm.addListener(alarm => { void onAlarm(alarm).catch(report); });
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || sender.url?.split('#')[0] !== FEED_URL || typeof message?.type !== 'string') return false;
  handleMessage(message).then(result => respond({ ok: true, ...result }),
    error => respond({ ok: false, error: error.message || 'The action could not be completed.' }));
  return true;
});
