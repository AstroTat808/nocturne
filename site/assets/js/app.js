const header = document.querySelector('.site-header');
const menuToggle = document.querySelector('.menu-toggle');
const nav = document.querySelector('.nav');

// Preserve the supplied 1536x768 NOCTURNE logo at its native 2:1 aspect ratio.
// This intentionally overrides any inherited sizing that could distort it.
const heroLogo = document.querySelector('.hero-logo');
if (heroLogo) {
  heroLogo.setAttribute('width', '1536');
  heroLogo.setAttribute('height', '768');
  Object.assign(heroLogo.style, {
    width: 'min(760px, 100%)',
    height: 'auto',
    aspectRatio: '2 / 1',
    objectFit: 'contain',
    maxWidth: '100%',
    marginLeft: '0',
    transform: 'none',
    flexShrink: '0'
  });
}

const onScroll = () => header?.classList.toggle('scrolled', window.scrollY > 30);
onScroll();
window.addEventListener('scroll', onScroll, { passive: true });

menuToggle?.addEventListener('click', () => {
  const open = nav.classList.toggle('open');
  menuToggle.setAttribute('aria-expanded', String(open));
});

document.querySelectorAll('.nav a').forEach((link) => link.addEventListener('click', () => {
  nav?.classList.remove('open');
  menuToggle?.setAttribute('aria-expanded', 'false');
}));

document.querySelectorAll('.faq-item button').forEach((button) => {
  button.addEventListener('click', () => {
    const item = button.closest('.faq-item');
    const open = item.classList.toggle('open');
    button.setAttribute('aria-expanded', String(open));
  });
});

const observer = new IntersectionObserver((entries) => {
  entries.forEach((entry) => {
    if (entry.isIntersecting) {
      entry.target.classList.add('visible');
      observer.unobserve(entry.target);
    }
  });
}, { threshold: .12 });
document.querySelectorAll('.reveal').forEach((el) => observer.observe(el));

const form = document.querySelector('#application-form');
if (form) {
  const status = form.querySelector('.form-status');
  form.addEventListener('submit', (event) => {
    const narrative = form.querySelector('[name="why_nocturne"]');
    if (narrative && narrative.value.trim().length < 50) {
      event.preventDefault();
      status.textContent = 'Please tell us a little more — at least 50 characters.';
      narrative.focus();
      return;
    }
    status.textContent = 'Submitting your request…';
  });
}

const canvas = document.querySelector('#stars');
if (canvas && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
  const ctx = canvas.getContext('2d');
  let w, h, dpr, particles;
  const resize = () => {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = canvas.clientWidth; h = canvas.clientHeight;
    canvas.width = w * dpr; canvas.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    particles = Array.from({ length: Math.min(110, Math.floor(w / 10)) }, () => ({
      x: Math.random() * w,
      y: Math.random() * h,
      r: Math.random() * 1.15 + .2,
      a: Math.random() * .5 + .15,
      s: Math.random() * .08 + .02
    }));
  };
  const draw = () => {
    ctx.clearRect(0, 0, w, h);
    for (const p of particles) {
      p.y -= p.s;
      if (p.y < -2) { p.y = h + 2; p.x = Math.random() * w; }
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(255,202,97,${p.a})`;
      ctx.fill();
    }
    requestAnimationFrame(draw);
  };
  resize(); draw();
  window.addEventListener('resize', resize, { passive: true });
}
