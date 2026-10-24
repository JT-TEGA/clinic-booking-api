(function () {
  'use strict';

  // Mirrors the server's check; the server stays the source of truth.
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const PAGE_SIZE = 5;
  const STORAGE_KEY = 'ilera.lastEmail';
  const DEFAULT_RETRY_SECONDS = 60;
  // The API stores only a provider string; specialties are presentation only.
  const SPECIALTIES = {
    'Dr Tega Ukpe': 'General Practice',
    'Dr James Hope': 'Paediatrics',
    'Dr Adrian Alas': 'Dermatology',
  };
  // Avatar tint per specialty (classes in style.css); unknown specialties get the neutral tint.
  const AVATAR_TONES = {
    'General Practice': 'gp',
    Paediatrics: 'paeds',
    Dermatology: 'derm',
  };

  const state = {
    slots: [],
    slotsById: new Map(),
    slotsStatus: 'loading', // loading | ready | error
    slotsSeq: 0,
    selectedDay: null,
    selectedSlotId: null,
    step: 1,
    idemKey: null,
    idemSig: null,
    submitting: false,
    retryTimer: null,
    lastBooking: null,
    lastBookingSlot: null,
    mine: { email: '', bookings: [], cursor: null, searched: false, loading: false, seq: 0 },
  };

  // ---------- Helpers ----------

  const $ = (id) => document.getElementById(id);

  function h(tag, attrs, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs || {})) {
      if (value === null || value === undefined || value === false) continue;
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = value;
      else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
      else if (value === true) node.setAttribute(key, '');
      else node.setAttribute(key, value);
    }
    for (const child of children.flat()) {
      if (child !== null && child !== undefined && child !== false) node.append(child);
    }
    return node;
  }

  function announce(message) {
    const live = $('live');
    live.textContent = '';
    // A fresh text node after clearing makes screen readers re-read repeated messages.
    window.setTimeout(() => { live.textContent = message; }, 50);
  }

  function storageGet(key) {
    try { return window.localStorage.getItem(key); } catch (err) { return null; }
  }

  function storageSet(key, value) {
    try { window.localStorage.setItem(key, value); } catch (err) { /* private mode: not essential */ }
  }

  function newIdempotencyKey() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
    return `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}-${Math.random().toString(16).slice(2)}`;
  }

  // Every request goes through here. Network failures throw; HTTP errors resolve with their status.
  async function api(method, path, body, extraHeaders) {
    const headers = Object.assign({ 'X-API-Key': window.API_KEY || '' }, extraHeaders);
    const init = { method, headers };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const res = await fetch(path, init);
    let data = null;
    try { data = await res.json(); } catch (err) { data = null; }
    return { status: res.status, data, headers: res.headers };
  }

  function errorMessage(res, fallback) {
    return (res && res.data && typeof res.data.error === 'string' && res.data.error) || fallback;
  }

  // ---------- Formatting (viewer's local timezone) ----------

  const fmtDate = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  const fmtWeekday = new Intl.DateTimeFormat(undefined, { weekday: 'short' });
  const fmtDayNum = new Intl.DateTimeFormat(undefined, { day: 'numeric' });
  const fmtMonth = new Intl.DateTimeFormat(undefined, { month: 'short' });
  const fmtLongDate = new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
  const fmtTime = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });

  function timeRange(start, end) {
    try { return fmtTime.formatRange(start, end); } catch (err) { return `${fmtTime.format(start)} – ${fmtTime.format(end)}`; }
  }

  function dayKey(date) {
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${date.getFullYear()}-${m}-${d}`;
  }

  function slotStart(slot) { return new Date(slot.start); }
  function slotEnd(slot) { return new Date(slot.end); }
  function isFuture(slot) { return slotStart(slot).getTime() > Date.now(); }

  function initials(provider) {
    const words = provider.replace(/^Dr\.?\s+/i, '').split(/\s+/).filter(Boolean);
    return words.slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?';
  }

  function statusPill(status) {
    const label = status === 'confirmed' ? 'Confirmed' : 'Cancelled';
    return h('span', { class: `pill pill--${status === 'confirmed' ? 'confirmed' : 'cancelled'}`, text: label });
  }

  function errorNotice(message, actionLabel, onAction) {
    return h('div', { class: 'notice notice--error', role: 'alert' },
      h('span', { text: message }),
      actionLabel ? h('button', { type: 'button', class: 'notice__action', text: actionLabel, onclick: onAction }) : null);
  }

  // ---------- Slots ----------

  async function loadSlots() {
    const seq = ++state.slotsSeq;
    if (!state.slots.length) {
      state.slotsStatus = 'loading';
      renderSlots();
    }
    try {
      const res = await api('GET', '/slots');
      if (seq !== state.slotsSeq) return;
      if (res.status !== 200 || !res.data || !Array.isArray(res.data.slots)) {
        throw new Error(errorMessage(res, `HTTP ${res.status}`));
      }
      state.slots = res.data.slots;
      state.slotsById = new Map(state.slots.map((s) => [s.id, s]));
      state.slotsStatus = 'ready';
    } catch (err) {
      if (seq !== state.slotsSeq) return;
      state.slotsStatus = 'error';
    }
    renderSlots();
    renderBookingList();
  }

  function futureDays() {
    const days = new Map();
    for (const slot of state.slots) {
      if (!isFuture(slot)) continue;
      const start = slotStart(slot);
      const key = dayKey(start);
      if (!days.has(key)) days.set(key, { key, date: start, slots: [] });
      days.get(key).slots.push(slot);
    }
    return days;
  }

  function renderSlots() {
    const strip = $('day-strip');
    const list = $('doctor-list');

    if (state.slotsStatus === 'loading') {
      strip.replaceChildren(...Array.from({ length: 4 }, () => h('div', { class: 'skeleton skeleton--day', 'aria-hidden': 'true' })));
      list.replaceChildren(
        h('p', { class: 'sr-only', text: 'Loading appointments…' }),
        ...Array.from({ length: 3 }, () => h('div', { class: 'skeleton skeleton--doctor', 'aria-hidden': 'true' })));
      list.setAttribute('aria-busy', 'true');
      updateContinue();
      return;
    }
    list.removeAttribute('aria-busy');

    if (state.slotsStatus === 'error' && !state.slots.length) {
      strip.replaceChildren();
      list.replaceChildren(errorNotice("We couldn't load appointments.", 'Retry', loadSlots));
      updateContinue();
      return;
    }

    const days = futureDays();
    if (!days.size) {
      strip.replaceChildren();
      list.replaceChildren(h('div', { class: 'empty' },
        h('p', { text: 'No open appointments right now. Check back soon.' }),
        h('button', { type: 'button', class: 'btn btn--ghost', text: 'Refresh', onclick: loadSlots })));
      state.selectedSlotId = null;
      updateContinue();
      return;
    }

    // Drop a selection that has since been booked or has started.
    const selected = state.slotsById.get(state.selectedSlotId);
    if (!selected || !selected.available || !isFuture(selected)) state.selectedSlotId = null;

    if (!days.has(state.selectedDay)) {
      const firstOpen = [...days.values()].find((d) => d.slots.some((s) => s.available));
      state.selectedDay = (firstOpen || days.values().next().value).key;
    }

    strip.replaceChildren(...[...days.values()].map(dayButton));
    const day = days.get(state.selectedDay);
    const refreshError = state.slotsStatus === 'error'
      ? errorNotice("Couldn't refresh appointments. Showing the last list we had.", 'Retry', loadSlots)
      : null;
    list.replaceChildren(...[refreshError, ...doctorGroups(day.slots)].filter(Boolean));
    updateContinue();
  }

  function dayButton(day) {
    const open = day.slots.filter((s) => s.available).length;
    const pressed = day.key === state.selectedDay;
    return h('button', {
      type: 'button',
      class: 'day',
      'data-day': day.key,
      'aria-pressed': String(pressed),
      'aria-label': `${fmtLongDate.format(day.date)}, ${open ? `${open} open` : 'fully booked'}`,
      onclick: () => selectDay(day.key),
    },
    h('span', { class: 'day__weekday', text: fmtWeekday.format(day.date) }),
    h('span', { class: 'day__num', text: fmtDayNum.format(day.date) }),
    h('span', { class: 'day__month', text: fmtMonth.format(day.date) }),
    h('span', { class: 'day__open', text: open ? `${open} open` : 'Full' }));
  }

  function doctorGroups(slots) {
    const byProvider = new Map();
    for (const slot of slots) {
      if (!byProvider.has(slot.provider)) byProvider.set(slot.provider, []);
      byProvider.get(slot.provider).push(slot);
    }
    return [...byProvider.entries()].map(([provider, providerSlots]) => {
      const specialty = SPECIALTIES[provider];
      const headingId = `doc-${provider.replace(/[^a-z0-9]+/gi, '-')}`;
      return h('section', { class: 'doctor', 'aria-labelledby': headingId },
        h('div', { class: 'doctor__head' },
          h('span', { class: `avatar avatar--${AVATAR_TONES[specialty] || 'default'}`, 'aria-hidden': 'true', text: initials(provider) }),
          h('div', null,
            h('h3', { class: 'doctor__name', id: headingId, text: provider }),
            specialty ? h('p', { class: 'doctor__specialty', text: specialty }) : null)),
        h('div', { class: 'times', role: 'group', 'aria-label': `Times with ${provider}` },
          ...providerSlots.map(timeButton)));
    });
  }

  function timeButton(slot) {
    const start = slotStart(slot);
    const range = timeRange(start, slotEnd(slot));
    if (!slot.available) {
      return h('button', { type: 'button', class: 'time', disabled: true, 'aria-label': `${range}, booked` },
        h('span', { class: 'time__clock', text: fmtTime.format(start) }),
        h('span', { class: 'time__tag', text: 'Booked' }));
    }
    return h('button', {
      type: 'button',
      class: 'time',
      'data-slot': slot.id,
      'aria-pressed': String(slot.id === state.selectedSlotId),
      'aria-label': range,
      onclick: () => selectSlot(slot.id),
    }, h('span', { class: 'time__clock', text: fmtTime.format(start) }));
  }

  function selectDay(key) {
    state.selectedDay = key;
    renderSlots();
    const btn = document.querySelector(`.day[data-day="${key}"]`);
    if (!btn) return;
    // preventScroll so focus doesn't jump instantly and cancel the smooth scroll below.
    btn.focus({ preventScroll: true });
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    btn.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', inline: 'center', block: 'nearest' });
  }

  // Updated in place so keyboard focus stays on the pill the user just pressed.
  function selectSlot(id) {
    state.selectedSlotId = id;
    document.querySelectorAll('.time[data-slot]').forEach((btn) => {
      btn.setAttribute('aria-pressed', String(btn.dataset.slot === id));
    });
    $('book-notice').replaceChildren();
    updateContinue();
  }

  function updateContinue() {
    $('continue').disabled = !state.selectedSlotId;
  }

  // ---------- Steps ----------

  function goStep(step, { focus = true } = {}) {
    state.step = step;
    [1, 2, 3].forEach((n) => { $(`step-${n}`).hidden = n !== step; });
    renderStepper();
    if (step === 2) {
      // A fresh key per visit to step 2: a different slot or different details is a new request.
      state.idemKey = newIdempotencyKey();
      state.idemSig = null;
      $('submit-notice').replaceChildren();
      renderSummary();
    }
    if (focus) {
      const title = $(step === 3 ? 'step3-title' : `step${step}-title`);
      title.focus();
    }
  }

  function renderStepper() {
    document.querySelectorAll('.stepper__step').forEach((li) => {
      const n = Number(li.dataset.step);
      const done = n < state.step || state.step === 3;
      li.classList.toggle('is-done', done);
      li.classList.toggle('is-current', n === state.step && !done);
      if (n === state.step) li.setAttribute('aria-current', 'step');
      else li.removeAttribute('aria-current');
    });
  }

  function slotSummary(slot) {
    const start = slotStart(slot);
    const specialty = SPECIALTIES[slot.provider];
    return [
      h('p', { class: 'summary__doctor', text: specialty ? `${slot.provider} · ${specialty}` : slot.provider }),
      h('p', { class: 'summary__meta', text: `${fmtDate.format(start)} · ${timeRange(start, slotEnd(slot))}` }),
    ];
  }

  function renderSummary() {
    const slot = state.slotsById.get(state.selectedSlotId);
    $('summary-text').replaceChildren(...(slot ? slotSummary(slot) : []));
  }

  function backToTimes(message) {
    state.selectedSlotId = null;
    goStep(1);
    $('book-notice').replaceChildren(errorNotice(message));
    announce(message);
    loadSlots();
  }

  // ---------- Details form ----------

  function setFieldError(input, errorEl, message) {
    if (message) {
      input.setAttribute('aria-invalid', 'true');
      errorEl.textContent = message;
      errorEl.hidden = false;
    } else {
      input.removeAttribute('aria-invalid');
      errorEl.textContent = '';
      errorEl.hidden = true;
    }
  }

  function validateDetails() {
    const nameInput = $('name');
    const emailInput = $('email');
    const name = nameInput.value.trim();
    const email = emailInput.value.trim();
    const nameError = name ? '' : 'Please enter your full name.';
    let emailError = '';
    if (!email) emailError = 'Please enter your email.';
    else if (!EMAIL_RE.test(email.toLowerCase())) emailError = 'Please enter a valid email, like ada@example.com.';
    setFieldError(nameInput, $('name-error'), nameError);
    setFieldError(emailInput, $('email-error'), emailError);
    if (nameError) nameInput.focus();
    else if (emailError) emailInput.focus();
    return nameError || emailError ? null : { name, email };
  }

  function setSubmitting(on) {
    state.submitting = on;
    const btn = $('confirm');
    btn.setAttribute('aria-busy', String(on));
    btn.replaceChildren(...(on ? [h('span', { class: 'spinner', 'aria-hidden': 'true' }), 'Booking…'] : ['Confirm booking']));
    btn.disabled = on || Boolean(state.retryTimer);
  }

  async function submitBooking(event) {
    if (event) event.preventDefault();
    if (state.submitting || state.retryTimer) return;
    const details = validateDetails();
    if (!details) return;
    const slot = state.slotsById.get(state.selectedSlotId);
    if (!slot) {
      backToTimes('Please choose a time first.');
      return;
    }

    const body = { slot_id: slot.id, name: details.name, email: details.email };
    const sig = JSON.stringify(body);
    // Same key only for a byte-identical retry; edited details are a different request.
    if (state.idemSig !== null && state.idemSig !== sig) state.idemKey = newIdempotencyKey();
    state.idemSig = sig;

    $('submit-notice').replaceChildren();
    setSubmitting(true);
    let res;
    try {
      res = await api('POST', '/bookings', body, { 'Idempotency-Key': state.idemKey });
    } catch (err) {
      // Keep the key: the first attempt may have landed, and the retry must not double-book.
      setSubmitting(false);
      const msg = "We couldn't reach the clinic. Check your connection and try again.";
      $('submit-notice').replaceChildren(errorNotice(msg, 'Try again', () => submitBooking()));
      announce(msg);
      return;
    }
    setSubmitting(false);
    // The server answered, so the next attempt is a new request with a new key.
    state.idemKey = newIdempotencyKey();
    state.idemSig = null;
    handleBookingResponse(res, slot);
  }

  function handleBookingResponse(res, slot) {
    switch (res.status) {
      case 201:
        state.lastBooking = res.data;
        state.lastBookingSlot = slot;
        renderConfirmation();
        goStep(3);
        announce(`Booking confirmed with ${slot.provider}.`);
        loadSlots();
        return;
      case 409:
        backToTimes('Someone just booked this slot. Please pick another time.');
        return;
      case 404:
        backToTimes('That slot no longer exists.');
        return;
      case 400: {
        const msg = errorMessage(res, 'Please check your details and try again.');
        $('submit-notice').replaceChildren(errorNotice(capitalise(msg)));
        announce(capitalise(msg));
        return;
      }
      case 429: {
        const seconds = parseInt(res.headers.get('Retry-After'), 10);
        startCountdown(Number.isFinite(seconds) && seconds > 0 ? seconds : DEFAULT_RETRY_SECONDS);
        return;
      }
      default: {
        const msg = 'Something went wrong. Please try again.';
        $('submit-notice').replaceChildren(errorNotice(msg));
        announce(msg);
      }
    }
  }

  function capitalise(text) {
    return text.charAt(0).toUpperCase() + text.slice(1);
  }

  // The visible countdown is not a live region; one announcement at start and end is enough.
  function startCountdown(seconds) {
    window.clearInterval(state.retryTimer);
    let left = seconds;
    const el = $('countdown');
    const render = () => {
      el.textContent = `Too many attempts. Try again in ${left} second${left === 1 ? '' : 's'}.`;
    };
    render();
    el.hidden = false;
    announce(`Too many attempts. Try again in ${left} seconds.`);
    state.retryTimer = window.setInterval(() => {
      left -= 1;
      if (left > 0) {
        render();
        return;
      }
      window.clearInterval(state.retryTimer);
      state.retryTimer = null;
      el.hidden = true;
      el.textContent = '';
      $('confirm').disabled = state.submitting;
      announce('You can try booking again now.');
    }, 1000);
    $('confirm').disabled = true;
  }

  // ---------- Confirmation ----------

  function renderConfirmation() {
    const booking = state.lastBooking;
    const slot = state.lastBookingSlot;
    const start = slotStart(slot);
    const specialty = SPECIALTIES[slot.provider];
    const firstName = capitalise(booking.name.split(/\s+/)[0]);
    $('confirmed-greeting').textContent = `You're booked, ${firstName}.`;

    const copyBtn = h('button', {
      type: 'button',
      class: 'ticket__copy',
      'aria-label': 'Copy full booking reference',
      text: 'Copy',
      onclick: async () => {
        const ok = await copyText(booking.id);
        copyBtn.textContent = ok ? 'Copied' : 'Copy failed';
        announce(ok ? 'Booking reference copied.' : 'Could not copy the booking reference.');
        window.setTimeout(() => { copyBtn.textContent = 'Copy'; }, 2000);
      },
    });

    const rows = [
      ['Doctor', slot.provider],
      specialty ? ['Specialty', specialty] : null,
      ['Date', fmtLongDate.format(start)],
      ['Time', timeRange(start, slotEnd(slot))],
      ['Email', booking.email],
      ['Status', statusPill(booking.status)],
    ].filter(Boolean);

    $('confirmed-details').replaceChildren(...rows.map(([label, value]) =>
      h('div', { class: 'details__row' }, h('dt', { text: label }), h('dd', null, value))));

    $('confirmed-ticket').replaceChildren(h('div', { class: 'ticket' },
      h('div', { class: 'ticket__main' },
        h('p', { class: 'ticket__label', text: 'Booking reference' }),
        h('code', { class: 'ticket__code', title: booking.id, text: booking.id.slice(0, 8) })),
      h('div', { class: 'ticket__stub' }, copyBtn)));
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (err) {
      const area = h('textarea', { class: 'sr-only', readonly: true });
      area.value = text;
      document.body.append(area);
      area.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      area.remove();
      return ok;
    }
  }

  function bookAnother() {
    state.selectedSlotId = null;
    $('details-form').reset();
    setFieldError($('name'), $('name-error'), '');
    setFieldError($('email'), $('email-error'), '');
    $('book-notice').replaceChildren();
    goStep(1);
    loadSlots();
  }

  // ---------- Tabs ----------

  function switchTab(name, { focus = false } = {}) {
    const book = name === 'book';
    $('view-book').hidden = !book;
    $('view-mine').hidden = book;
    if (book) {
      $('tab-book').setAttribute('aria-current', 'page');
      $('tab-mine').removeAttribute('aria-current');
    } else {
      $('tab-mine').setAttribute('aria-current', 'page');
      $('tab-book').removeAttribute('aria-current');
    }
    if (focus) $(book ? `step${state.step}-title` : 'mine-title').focus();
  }

  // ---------- My bookings ----------

  async function findBookings(event) {
    if (event) event.preventDefault();
    const input = $('lookup-email');
    const email = input.value.trim();
    let error = '';
    if (!email) error = 'Please enter your email.';
    else if (!EMAIL_RE.test(email.toLowerCase())) error = 'Please enter a valid email, like ada@example.com.';
    setFieldError(input, $('lookup-error'), error);
    if (error) {
      input.focus();
      return;
    }
    storageSet(STORAGE_KEY, email);
    state.mine = { email, bookings: [], cursor: null, searched: false, loading: false, seq: state.mine.seq + 1 };
    renderBookingList();
    await fetchBookingsPage();
  }

  async function fetchBookingsPage() {
    const mine = state.mine;
    const seq = mine.seq;
    const first = mine.bookings.length === 0;
    let path = `/bookings?email=${encodeURIComponent(mine.email)}&limit=${PAGE_SIZE}`;
    if (mine.cursor) path += `&cursor=${encodeURIComponent(mine.cursor)}`;

    mine.loading = true;
    setLookupBusy(true, first);
    $('mine-notice').replaceChildren();
    let res;
    try {
      res = await api('GET', path);
    } catch (err) {
      if (seq !== state.mine.seq) return;
      mine.loading = false;
      setLookupBusy(false, first);
      const msg = "We couldn't reach the clinic. Check your connection and try again.";
      $('mine-notice').replaceChildren(errorNotice(msg, 'Retry', fetchBookingsPage));
      announce(msg);
      return;
    }
    if (seq !== state.mine.seq) return;
    mine.loading = false;
    setLookupBusy(false, first);

    if (res.status !== 200 || !res.data || !Array.isArray(res.data.bookings)) {
      const msg = res.status === 400 ? capitalise(errorMessage(res, 'Please check the email.')) : 'Something went wrong. Please try again.';
      $('mine-notice').replaceChildren(errorNotice(msg));
      announce(msg);
      return;
    }
    mine.bookings = mine.bookings.concat(res.data.bookings);
    mine.cursor = res.data.next_cursor;
    mine.searched = true;
    renderBookingList();
    if (first) {
      const n = mine.bookings.length;
      announce(n ? `Showing ${n}${mine.cursor ? ' or more' : ''} booking${n === 1 ? '' : 's'}.` : 'No bookings for this email yet.');
    } else {
      announce(`Loaded ${res.data.bookings.length} more.`);
    }
  }

  function setLookupBusy(on, first) {
    const btn = first ? $('lookup-submit') : $('load-more');
    btn.disabled = on;
    btn.setAttribute('aria-busy', String(on));
    if (first) btn.textContent = on ? 'Finding…' : 'Find bookings';
    else btn.textContent = on ? 'Loading…' : 'Load more';
  }

  function renderBookingList() {
    const mine = state.mine;
    $('booking-list').replaceChildren(...mine.bookings.map(bookingRow));
    $('mine-empty').hidden = !(mine.searched && mine.bookings.length === 0);
    $('load-more').hidden = !mine.cursor;
  }

  function bookingRow(booking) {
    const slot = state.slotsById.get(booking.slot_id);
    let doctor = `Slot ${booking.slot_id}`;
    let meta = 'Time not available';
    let specialty = null;
    if (slot) {
      const start = slotStart(slot);
      doctor = slot.provider;
      specialty = SPECIALTIES[slot.provider] || null;
      meta = `${fmtDate.format(start)} · ${timeRange(start, slotEnd(slot))}`;
    }
    const li = h('li', { class: 'booking', 'data-id': booking.id, tabindex: '-1' },
      h('div', { class: 'booking__top' },
        h('div', null,
          h('p', { class: 'booking__doctor', text: specialty ? `${doctor} · ${specialty}` : doctor }),
          h('p', { class: 'booking__meta', text: meta })),
        statusPill(booking.status)));
    if (booking.status === 'confirmed') {
      const actions = h('div', { class: 'booking__actions' });
      li.append(actions);
      showCancelButton(actions, booking);
    }
    return li;
  }

  function showCancelButton(actions, booking) {
    const btn = h('button', {
      type: 'button',
      class: 'btn btn--ghost btn--small',
      text: 'Cancel',
      'aria-label': 'Cancel this appointment',
      onclick: () => showCancelConfirm(actions, booking),
    });
    actions.replaceChildren(btn);
    return btn;
  }

  // Inline confirmation instead of window.confirm, which blocks the page and can't be styled.
  function showCancelConfirm(actions, booking, errorText) {
    const keep = h('button', {
      type: 'button',
      class: 'btn btn--ghost btn--small',
      text: 'Keep it',
      onclick: () => showCancelButton(actions, booking).focus(),
    });
    const yes = h('button', {
      type: 'button',
      class: 'btn btn--danger btn--small',
      text: 'Yes, cancel',
      onclick: () => cancelBooking(actions, booking, yes, keep),
    });
    actions.replaceChildren(
      h('p', { class: 'booking__prompt', text: 'Cancel this appointment?' }),
      yes,
      keep,
      errorText ? h('p', { class: 'booking__error', role: 'alert', text: errorText }) : null);
    keep.focus();
  }

  async function cancelBooking(actions, booking, yes, keep) {
    yes.disabled = true;
    keep.disabled = true;
    yes.textContent = 'Cancelling…';
    let res;
    try {
      res = await api('DELETE', `/bookings/${encodeURIComponent(booking.id)}`);
    } catch (err) {
      showCancelConfirm(actions, booking, "We couldn't reach the clinic. Please try again.");
      return;
    }
    if (res.status === 200 || res.status === 409) {
      const updated = res.status === 200 ? res.data : Object.assign({}, booking, { status: 'cancelled' });
      replaceBooking(updated);
      announce(res.status === 200 ? 'Appointment cancelled.' : 'This appointment was already cancelled.');
      loadSlots();
    } else if (res.status === 404) {
      showCancelConfirm(actions, booking, 'We could not find this booking.');
    } else {
      showCancelConfirm(actions, booking, 'Something went wrong. Please try again.');
    }
  }

  function replaceBooking(updated) {
    const i = state.mine.bookings.findIndex((b) => b.id === updated.id);
    if (i < 0) return;
    state.mine.bookings[i] = updated;
    const old = document.querySelector(`.booking[data-id="${updated.id}"]`);
    if (!old) return;
    const row = bookingRow(updated);
    old.replaceWith(row);
    row.focus();
  }

  // ---------- Wiring ----------

  function init() {
    $('tab-book').addEventListener('click', () => switchTab('book', { focus: true }));
    $('tab-mine').addEventListener('click', () => switchTab('mine', { focus: true }));

    $('continue').addEventListener('click', () => {
      if (!state.selectedSlotId) return;
      $('book-notice').replaceChildren();
      goStep(2);
    });
    $('change-slot').addEventListener('click', () => goStep(1));
    $('details-form').addEventListener('submit', submitBooking);
    ['name', 'email'].forEach((id) => {
      $(id).addEventListener('input', () => {
        if ($(id).getAttribute('aria-invalid') === 'true') setFieldError($(id), $(`${id}-error`), '');
      });
    });

    $('book-another').addEventListener('click', bookAnother);
    $('go-mine').addEventListener('click', () => {
      $('lookup-email').value = state.lastBooking ? state.lastBooking.email : '';
      switchTab('mine', { focus: true });
      findBookings();
    });

    $('lookup-form').addEventListener('submit', findBookings);
    $('load-more').addEventListener('click', fetchBookingsPage);

    const remembered = storageGet(STORAGE_KEY);
    if (remembered) $('lookup-email').value = remembered;

    goStep(1, { focus: false });
    loadSlots();
  }

  init();
})();
