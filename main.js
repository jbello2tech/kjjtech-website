// Nav scroll shadow
const nav = document.querySelector('.nav');
window.addEventListener('scroll', () => {
  nav.classList.toggle('scrolled', window.scrollY > 10);
});

// Mobile nav toggle
const toggle = document.querySelector('.nav__toggle');
const navLinks = document.querySelector('.nav__links');

toggle.addEventListener('click', () => {
  navLinks.classList.toggle('open');
});

// Close mobile nav when a link is clicked
navLinks.querySelectorAll('a').forEach(link => {
  link.addEventListener('click', () => navLinks.classList.remove('open'));
});

// Back to top
const backToTop = document.getElementById('backToTop');
window.addEventListener('scroll', () => {
  backToTop.classList.toggle('visible', window.scrollY > 400);
});
backToTop.addEventListener('click', () => {
  window.scrollTo({ top: 0, behavior: 'smooth' });
});

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

  nav.hidden = false;
  render();
})();
