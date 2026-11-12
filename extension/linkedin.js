// Chrome serializes this function for injection into a disposable activity tab.
// Keep its helpers inside the function so they are available in that document.
export async function collectActivity(profileUrl) {
  const origin = 'https://www.linkedin.com';
  const cardSelector = '[role="listitem"][componentkey^="update-card-focus"]';
  const ageUnits = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000, mo: 2_592_000_000, y: 31_536_000_000 };
  const checkedAt = Date.now();
  const deadline = checkedAt + 17_000;
  const activityPath = new URL('recent-activity/all/', profileUrl).pathname;
  const profilePath = decodeURIComponent(new URL(profileUrl).pathname).toLowerCase();

  const visible = element => Boolean(element?.getClientRects().length) &&
    !element.closest('[hidden], [aria-hidden="true"]');

  function waitFor(read, timeout) {
    const ready = read();
    if (ready) return Promise.resolve(ready);
    return new Promise(resolve => {
      const finish = value => {
        observer.disconnect();
        clearTimeout(timer);
        resolve(value || null);
      };
      const observer = new MutationObserver(() => {
        const value = read();
        if (value) finish(value);
      });
      const timer = setTimeout(() => finish(read()), Math.max(0, Math.min(timeout, deadline - Date.now())));
      observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
    });
  }

  function pageProblem() {
    if (/^\/(?:login|uas\/login|authwall|checkpoint)(?:\/|$)/i.test(location.pathname)) return 'sign-in';
    if (location.origin !== origin || location.pathname.replace(/\/$/, '') !== activityPath.replace(/\/$/, '')) return 'unavailable';
    const main = document.querySelector('main, [role="main"]');
    const message = document.querySelector(cardSelector) ? document.title : (main?.innerText.slice(0, 1500) || document.title);
    if (/too many requests|temporarily restricted|commercial use limit/i.test(message)) return 'rate-limit';
    return null;
  }

  function profileLink(anchor) {
    try {
      const url = new URL(anchor.href);
      return url.origin === origin && `${decodeURIComponent(url.pathname).toLowerCase().replace(/\/$/, '')}/` === profilePath;
    } catch {
      return false;
    }
  }

  function postLayout(row) {
    const root = row?.querySelector('h2')?.parentElement;
    const children = Array.from(root?.children || []);
    const header = children[1];
    const controls = children.findIndex(child => child.querySelector('button[aria-label^="Reaction button state:"]'));
    if (!header || controls < 2) return null;
    const regions = children.slice(2, controls);
    const body = regions.find(element => element.tagName === 'P');
    return { header, regions, body, footer: children[controls] };
  }

  function moreButton(body) {
    return [...(body?.querySelectorAll('button') || [])].find(button => visible(button) &&
      /^(?:…|\.\.\.)?\s*(?:see )?more$/i.test(button.innerText.trim()));
  }

  function relativeAge(header) {
    const labels = [...header.querySelectorAll('p')].reverse();
    for (const label of labels) {
      const text = label.innerText.trim();
      if (/^(?:just now|now)(?:\s|$)/i.test(text)) return { age: 0, unit: 60_000 };
      const match = text.match(/^(\d+)\s*(mo|[smhdwy])(?:\s|$)/i);
      if (match) {
        const unit = ageUnits[match[2].toLowerCase()];
        return { age: Number(match[1]) * unit, unit };
      }
    }
    return null;
  }

  function publishedTime(id, header, age) {
    const time = header.querySelector('time[datetime]');
    const explicit = Date.parse(time?.getAttribute('datetime') || '');
    if (Number.isFinite(explicit)) return { publishedAt: explicit, approximateDate: false };
    // The timestamp in the observed LinkedIn IDs matched the date labels on
    // both test profiles. Use it only when it agrees with the visible age.
    const fromId = Number(BigInt(id) >> 22n);
    const idAge = checkedAt - fromId;
    const plausible = fromId >= Date.UTC(2015, 0, 1) && idAge >= -300_000;
    if (plausible && (!age || (idAge >= age.age - 300_000 && idAge < age.age + age.unit + 300_000))) {
      return { publishedAt: fromId, approximateDate: false };
    }
    return age ? { publishedAt: checkedAt - age.age, approximateDate: true } : null;
  }

  function parseLink(value) {
    if (typeof value !== 'string' || !value.trim()) return null;
    try {
      const link = new URL(value.trim(), origin);
      if (link.origin !== origin || link.username || link.password) return null;
      const pathname = decodeURIComponent(link.pathname);
      const urn = pathname.match(/^\/(embed\/)?feed\/update\/(urn:li:(?:activity|share|ugcPost):(\d{15,25}))\/?$/);
      if (urn) return {
        id: urn[3], url: `${origin}/feed/update/${urn[2]}/`,
        embedUrl: urn[1] ? `${origin}/embed/feed/update/${urn[2]}/` : null,
      };
      const post = pathname.match(/^\/posts\/[^/\s?#]*-activity-(\d{15,25})-[^/\s?#]+\/?$/);
      return post ? { id: post[1], url: `${origin}${link.pathname.replace(/\/$/, '')}/`, embedUrl: null } : null;
    } catch {
      return null;
    }
  }

  function renderedLink(row, layout) {
    for (const part of [layout.header, layout.footer, ...Array.from(row.children).slice(1)]) {
      for (const anchor of part.querySelectorAll('a[href]')) {
        const direct = parseLink(anchor.href);
        if (direct) return direct;
        const analytics = anchor.pathname.match(/^\/analytics\/post-summary\/(urn:li:activity:\d{15,25})\/?$/);
        if (anchor.origin === origin && analytics) return parseLink(`/feed/update/${analytics[1]}/`);
      }
    }
    return null;
  }

  function menuItems() {
    for (const element of document.querySelectorAll('[role="menu"]')) {
      const items = [...element.querySelectorAll('[role="menuitem"]')].filter(visible);
      const named = label => items.find(item => item.innerText.trim() === label);
      const embed = named('Embed this post');
      const copy = named('Copy link to post');
      if (embed || copy) return { element, embed, copy };
    }
    return null;
  }

  async function openMenu(trigger) {
    let button = trigger();
    if (!button || button.disabled) return null;
    const readOpenMenu = () => trigger()?.getAttribute('aria-expanded') === 'true' && menuItems();
    if (button.getAttribute('aria-expanded') !== 'true') button.click();
    const menu = await waitFor(readOpenMenu, 1350);
    if (menu) return menu;
    button = trigger();
    if (!button || button.disabled || button.getAttribute('aria-expanded') === 'true') return null;
    // The activity cards can render before their controls respond to clicks.
    button.scrollIntoView({ block: 'nearest' });
    button.focus({ preventScroll: true });
    button.click();
    return waitFor(readOpenMenu, 1350);
  }

  function linkFromEmbedMenu(item) {
    try {
      const href = new URL(item.getAttribute('href') || '', origin);
      if (href.origin !== origin || href.username || href.password ||
          href.pathname.replace(/\/$/, '') !== '/preload/embed-modal') return null;
      const urn = href.searchParams.get('targetUrn');
      if (!/^urn:li:(?:activity|share|ugcPost):\d{15,25}$/.test(urn || '')) return null;
      return parseLink(`/embed/feed/update/${urn}/`);
    } catch {
      return null;
    }
  }

  function embedDialog() {
    return [...document.querySelectorAll('dialog, [role="dialog"]')].find(dialog =>
      visible(dialog) && (dialog.getAttribute('aria-label') === 'Embed this post' ||
        [...dialog.querySelectorAll('h1, h2, h3')].some(heading => heading.innerText.trim() === 'Embed this post')));
  }

  async function linkFromEmbed(item) {
    item.click();
    try {
      return await waitFor(() => {
        const dialog = embedDialog();
        for (const frame of dialog?.querySelectorAll('iframe[src]') || []) {
          const link = parseLink(frame.src);
          if (link?.embedUrl) return link;
        }
        return null;
      }, 1700);
    } finally {
      const dialog = embedDialog();
      const buttons = [...(dialog?.querySelectorAll('button') || [])];
      const named = label => buttons.find(button =>
        (button.getAttribute('aria-label') || button.title || button.innerText).trim() === label);
      const close = named('Dismiss') || named('Close modal');
      if (close) {
        close.click();
        await waitFor(() => !embedDialog(), 900);
      }
    }
  }

  async function linkFromCopy(item) {
    // Capture only the write from this menu action in our inactive tab. This
    // keeps the user's system clipboard out of both manual and scheduled runs.
    const clipboard = navigator.clipboard;
    if (!clipboard || typeof clipboard.writeText !== 'function') return null;
    const previous = Object.getOwnPropertyDescriptor(clipboard, 'writeText');
    let link = null;
    const capture = text => {
      link = parseLink(text);
      return Promise.resolve();
    };
    try {
      Object.defineProperty(clipboard, 'writeText', { value: capture, configurable: true, writable: true });
    } catch {
      return null;
    }
    try {
      item.click();
      return await waitFor(() => link, 750);
    } finally {
      if (clipboard.writeText === capture) {
        if (previous) Object.defineProperty(clipboard, 'writeText', previous);
        else delete clipboard.writeText;
      }
    }
  }

  async function postLink(currentRow, layout, media) {
    const row = currentRow();
    if (!row) return null;
    const direct = renderedLink(row, layout);
    const needsEmbed = media.some(item => item.type === 'video' && !item.url);
    if (direct && !needsEmbed) return direct;
    const trigger = () => postLayout(currentRow())?.header.querySelector('button[aria-label^="Open control menu for post"]');
    let menu;
    try {
      menu = await openMenu(trigger);
      if (menu?.embed) {
        // LinkedIn exposes the post URN on the menu anchor before the preview opens.
        const link = linkFromEmbedMenu(menu.embed) || await linkFromEmbed(menu.embed);
        if (link) return link;
        menu = await openMenu(trigger);
      }
      return menu?.copy ? (await linkFromCopy(menu.copy)) || direct : direct;
    } finally {
      const button = trigger();
      if (button?.getAttribute('aria-expanded') === 'true') {
        button.click();
        await waitFor(() => trigger()?.getAttribute('aria-expanded') !== 'true' && !visible(menu?.element), 900);
      }
    }
  }

  function remoteMedia(value) {
    if (!value) return null;
    try {
      const url = new URL(value, origin);
      return url.protocol === 'https:' && !url.username && !url.password && !url.port &&
        (url.origin === origin || url.hostname.endsWith('.licdn.com')) ? url.href : null;
    } catch {
      return null;
    }
  }

  function imageSource(image) {
    const candidates = [image.getAttribute('srcset'), ...Array.from(image.closest('picture')?.querySelectorAll('source') || [], source => source.getAttribute('srcset'))];
    const sizes = candidates.filter(Boolean).flatMap(set => set.split(',').map(candidate => {
      const [url, size] = candidate.trim().split(/\s+/);
      return { url: remoteMedia(url), size: Number.parseFloat(size) || 0 };
    })).filter(candidate => candidate.url).sort((a, b) => b.size - a.size);
    return sizes[0]?.url || remoteMedia(image.currentSrc || image.getAttribute('src'));
  }

  function postMedia(regions) {
    const media = [];
    for (const region of regions) {
      const videos = [...region.querySelectorAll('video')];
      for (const video of videos) {
        const sources = [video.currentSrc, video.getAttribute('src'), ...Array.from(video.querySelectorAll('source[src]'), source => source.src)];
        media.push({ type: 'video', url: sources.map(remoteMedia).find(Boolean) || null, poster: remoteMedia(video.poster) });
      }
      const playControl = [...region.querySelectorAll('[aria-label]')].find(element => /^play video\b/i.test(element.getAttribute('aria-label')));
      if (!videos.length && playControl) {
        media.push({ type: 'video', url: null, poster: null });
      }
      for (const image of region.querySelectorAll('img')) {
        const source = imageSource(image);
        if (!source || image.closest('a[href*="/in/"]') || /profile-displayphoto|company-logo|emoji/i.test(new URL(source).pathname)) continue;
        if (image.naturalWidth && image.naturalWidth < 48 && image.alt !== 'View image') continue;
        if (!videos.some(video => remoteMedia(video.poster) === source)) media.push({ type: 'image', url: source, alt: image.alt });
      }
    }
    return media;
  }

  const state = await waitFor(() => {
    const problem = pageProblem();
    if (problem) return problem;
    if ([...document.querySelectorAll(cardSelector)].some(postLayout)) return 'ready';
    const mainText = document.querySelector('main, [role="main"]')?.innerText || '';
    if (/no (?:recent )?(?:activity|posts)(?: to (?:show|see)| yet)?\b|hasn.t posted yet/i.test(mainText)) return 'empty';
    return null;
  }, 6500);
  if (state !== 'ready' && state !== 'empty') return { status: state || 'unavailable' };

  const title = document.title.match(/^Activity\s*\|\s*(.*?)\s*\|\s*LinkedIn\s*$/i);
  let name = title?.[1] || '';
  const posts = [];
  let missed = 0;
  let missingLinks = 0;
  const rows = [...document.querySelectorAll(cardSelector)];
  for (const row of rows) {
    const key = row.getAttribute('componentkey');
    const currentRow = () => document.querySelector(`[componentkey="${CSS.escape(key)}"]`);
    let layout = postLayout(currentRow());
    if (!layout) {
      missed++;
      continue;
    }
    if (![...layout.header.querySelectorAll('a[href]')].some(profileLink)) continue;
    name = layout.header.querySelector('p')?.innerText.trim() || name;
    const age = relativeAge(layout.header);
    if (age?.age >= 7 * ageUnits.d) continue;
    if (Date.now() >= deadline - 400) {
      missed++;
      continue;
    }
    const expand = moreButton(layout.body);
    if (expand) {
      expand.click();
      layout = await waitFor(() => {
        const updated = postLayout(currentRow());
        return updated && !moreButton(updated.body) ? updated : null;
      }, 850);
      if (!layout) {
        missed++;
        continue;
      }
    }
    const text = layout.body?.innerText.trim() || '';
    const media = postMedia(layout.regions);
    const link = await postLink(currentRow, layout, media);
    if (!link) {
      missingLinks++;
      missed++;
      continue;
    }
    const time = publishedTime(link.id, layout.header, age);
    if (!time || (!text && !media.length)) {
      missed++;
      continue;
    }
    if (time.publishedAt < checkedAt - 7 * ageUnits.d) continue;
    posts.push({
      url: link.url,
      text,
      ...time,
      media: media.map(item => item.type === 'video' ? { ...item, embedUrl: link.embedUrl } : item),
    });
  }
  return { status: 'ok', name, posts, missed, missingLinks };
}
