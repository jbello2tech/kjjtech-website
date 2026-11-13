// Nav scroll shadow
const nav = document.querySelector('.nav');
if (nav) {
  window.addEventListener('scroll', () => {
    nav.classList.toggle('scrolled', window.scrollY > 10);
  });
}

// Mobile nav toggle
const toggle = document.querySelector('.nav__toggle');
const navLinks = document.querySelector('.nav__links');

if (toggle && navLinks) {
  toggle.addEventListener('click', () => {
    navLinks.classList.toggle('open');
  });

  // Close mobile nav when a link is clicked
  navLinks.querySelectorAll('a').forEach(link => {
    link.addEventListener('click', () => navLinks.classList.remove('open'));
  });
}

// Back to top
const backToTop = document.getElementById('backToTop');
if (backToTop) {
  window.addEventListener('scroll', () => {
    backToTop.classList.toggle('visible', window.scrollY > 400);
  });
  backToTop.addEventListener('click', () => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
}

// Animate cards on scroll
const observer = new IntersectionObserver(
  (entries) => entries.forEach(el => {
    if (el.isIntersecting) {
      el.target.style.opacity = '1';
      el.target.style.transform = 'translateY(0)';
    }
  }),
  { threshold: 0.1 }
);

document.querySelectorAll('.card, .stat, .about__text').forEach(el => {
  el.style.opacity = '0';
  el.style.transform = 'translateY(20px)';
  el.style.transition = 'opacity 0.5s ease, transform 0.5s ease';
  observer.observe(el);
});

// Testimonials carousel — 3 at a time, arrows appear only when there are 4+
(function initTestimonialsCarousel() {
  const grid = document.querySelector('.testimonials__grid');
  const nav = document.querySelector('.testimonials__nav');
  if (!grid || !nav) return;

  const cards = Array.from(grid.querySelectorAll('.testimonial'));
  const visible = 3;
  if (cards.length <= visible) return;

  // Display newest first by reversing DOM order of testimonial cards.
  // The REVIEWS:END marker stays at the end of the grid for the worker.
  cards.slice().reverse().forEach(card => grid.appendChild(card));
  const ordered = Array.from(grid.querySelectorAll('.testimonial'));

  const prev = nav.querySelector('[data-dir="prev"]');
  const next = nav.querySelector('[data-dir="next"]');
  const currentEl = nav.querySelector('[data-current]');
  const totalEl = nav.querySelector('[data-total]');

  let start = 0;
  const maxStart = ordered.length - visible;
  const totalPages = maxStart + 1;

  function render() {
    ordered.forEach((card, i) => {
      card.style.display = (i >= start && i < start + visible) ? '' : 'none';
    });
    prev.disabled = start === 0;
    next.disabled = start >= maxStart;
    if (currentEl) currentEl.textContent = String(start + 1);
    if (totalEl) totalEl.textContent = String(totalPages);
  }

  prev.addEventListener('click', () => { if (start > 0) { start--; render(); } });
  next.addEventListener('click', () => { if (start < maxStart) { start++; render(); } });

  // Touch swipe on mobile — horizontal drag over the grid
  let touchStartX = null;
  grid.addEventListener('touchstart', (e) => {
    touchStartX = e.changedTouches[0].clientX;
  }, { passive: true });
  grid.addEventListener('touchend', (e) => {
    if (touchStartX === null) return;
    const dx = e.changedTouches[0].clientX - touchStartX;
    touchStartX = null;
    if (Math.abs(dx) < 50) return;
    if (dx < 0 && start < maxStart) { start++; render(); }       // swipe left = older
    else if (dx > 0 && start > 0) { start--; render(); }          // swipe right = newer
  }, { passive: true });

  nav.hidden = false;
  render();
})();

// GA: track high-intent clicks (Stripe checkout, phone, email) site-wide
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[href]');
  if (!a || typeof gtag !== 'function') return;
  const href = a.getAttribute('href');
  if (href.includes('buy.stripe.com')) {
    gtag('event', 'begin_checkout', { link_url: href, page_path: location.pathname });
  } else if (href.startsWith('tel:')) {
    gtag('event', 'phone_click', { page_path: location.pathname });
  } else if (href.startsWith('mailto:')) {
    gtag('event', 'email_click', { page_path: location.pathname });
  } else if (href.includes('join.zoho.com')) {
    gtag('event', 'remote_session_click', { page_path: location.pathname });
  }
});


// Testimonials: clamp long quotes with a "Read more" toggle
(function () {
  document.querySelectorAll('.testimonial__quote').forEach(function (q) {
    if (q.textContent.trim().length < 380) return;
    q.classList.add('is-clamped');
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'testimonial__more';
    btn.textContent = 'Read more';
    btn.setAttribute('aria-expanded', 'false');
    btn.addEventListener('click', function () {
      var open = q.classList.toggle('is-clamped') === false;
      btn.textContent = open ? 'Show less' : 'Read more';
      btn.setAttribute('aria-expanded', String(open));
    });
    q.insertAdjacentElement('afterend', btn);
  });
})();


// Mobile contact bar (call + free assessment), hidden on the assessment landing page
(function () {
  if (/\/assessment(\.html)?$/.test(location.pathname)) return;
  var bar = document.createElement('div');
  bar.className = 'mobile-bar';
  bar.innerHTML = '<a class="mobile-bar__call" href="tel:+19145279957">Call</a>' +
                  '<a class="mobile-bar__call" href="sms:+19145279957">Text</a>' +
                  '<a class="mobile-bar__book" href="/assessment.html">Free assessment</a>';
  document.body.appendChild(bar);
  document.body.classList.add('has-mobile-bar');
})();


// Backup every Formspree form submission to the KJJ Tech worker (Discord + D1),
// so a lead is never lost if the notification email gets filtered.
(function () {
  if (!navigator.sendBeacon) return;
  document.querySelectorAll('form[action*="formspree.io"]').forEach(function (form) {
    form.addEventListener('submit', function () {
      try {
        var fd = new FormData(form);
        fd.append('page', location.pathname);
        navigator.sendBeacon('https://reviews.kjjtech.com/lead', fd);
      } catch (e) { /* never block the real submission */ }
    });
  });
})();

// Live Google reviews (homepage). Fetched only when the section scrolls into view;
// content isn't cached anywhere, per Google Places API terms.
(() => {
  const box = document.getElementById('google-reviews');
  if (!box) return;
  const ENDPOINT = 'https://reviews.kjjtech.com/google-reviews';
  const G_LOGO = '<svg viewBox="0 0 48 48" width="18" height="18" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>';
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  const link = (href, cls, text) => { const a = el('a', cls, text); a.href = href; a.target = '_blank'; a.rel = 'noopener'; return a; };
  const stars = n => '★★★★★'.slice(0, Math.round(n || 0)) + '☆☆☆☆☆'.slice(0, 5 - Math.round(n || 0));

  function render(d) {
    if (!d || d.capped || d.error || !d.reviews || !d.reviews.length) return;
    const head = el('div', 'g-reviews__head');
    const logo = el('span', 'g-reviews__logo'); logo.innerHTML = G_LOGO + '<span>Google</span>';
    head.append(logo, el('span', 'g-reviews__score', d.rating ? d.rating.toFixed(1) : ''), el('span', 'g-reviews__stars', stars(d.rating)),
      el('span', 'g-reviews__count', `${d.count} review${d.count === 1 ? '' : 's'} on Google`));
    const grid = el('div', 'g-reviews__grid');
    for (const r of d.reviews) {
      const card = el('div', 'g-review');
      const who = el('div', 'g-review__who');
      if (r.photo) { const img = el('img', 'g-review__photo'); img.src = r.photo; img.alt = ''; img.width = 36; img.height = 36; img.loading = 'lazy'; img.referrerPolicy = 'no-referrer'; who.append(img); }
      const meta = el('div');
      meta.append(r.authorUri ? link(r.authorUri, 'g-review__name', r.author) : el('span', 'g-review__name', r.author), el('div', 'g-review__when', r.when));
      who.append(meta);
      card.append(who, el('div', 'testimonial__stars', stars(r.rating)), el('p', 'g-review__text', r.text));
      if (r.uri) card.append(link(r.uri, 'g-review__more', 'Read on Google'));
      grid.append(card);
    }
    const foot = el('div', 'g-reviews__foot');
    foot.append(el('span', 'g-reviews__sort', 'Reviews selected by Google ("most relevant").'));
    if (d.reviewsUri) foot.append(link(d.reviewsUri, 'g-reviews__all', 'See all reviews on Google →'));
    box.replaceChildren(head, grid, foot);
    box.hidden = false;
  }

  const load = () => fetch(ENDPOINT).then(r => r.ok ? r.json() : null).then(render).catch(() => {});
  if (!('IntersectionObserver' in window)) return load();
  const io = new IntersectionObserver(es => { if (es.some(e => e.isIntersecting)) { io.disconnect(); load(); } }, { rootMargin: '300px' });
  io.observe(box.closest('section') || box);
})();
