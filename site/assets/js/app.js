const header = document.querySelector('.site-header');
const menuToggle = document.querySelector('.menu-toggle');
const nav = document.querySelector('.nav');

if (!document.querySelector('link[data-nocturne-premium]')) {
  const premiumStyles = document.createElement('link');
  premiumStyles.rel = 'stylesheet';
  premiumStyles.href = '/assets/css/premium.css';
  premiumStyles.dataset.nocturnePremium = 'true';
  document.head.appendChild(premiumStyles);
}

if (!document.querySelector('link[data-nocturne-icons]')) {
  const iconStyles = document.createElement('link');
  iconStyles.rel = 'stylesheet';
  iconStyles.href = '/assets/css/icons.css';
  iconStyles.dataset.nocturneIcons = 'true';
  document.head.appendChild(iconStyles);
}

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

function formatPhoneNumber(value = '') {
  let digits = String(value).replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) digits = digits.slice(1);
  digits = digits.slice(0, 10);
  if (digits.length <= 3) return digits;
  if (digits.length <= 6) return `${digits.slice(0, 3)}-${digits.slice(3)}`;
  return `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`;
}

const form = document.querySelector('#application-form');
if (form) {
  const status = form.querySelector('.form-status');
  const submitButton = form.querySelector('button[type="submit"]');
  const phone = form.querySelector('#phone');

  if (phone) {
    phone.addEventListener('input', () => {
      const formatted = formatPhoneNumber(phone.value);
      if (phone.value !== formatted) phone.value = formatted;
    });
    phone.addEventListener('blur', () => {
      phone.value = formatPhoneNumber(phone.value);
    });
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();

    const narrative = form.querySelector('[name="why_nocturne"]');
    if (narrative && narrative.value.trim().length < 50) {
      status.textContent = 'Please tell us a little more — at least 50 characters.';
      narrative.focus();
      return;
    }

    if (!form.reportValidity()) return;

    status.textContent = 'Submitting your request…';
    if (submitButton) submitButton.disabled = true;

    try {
      const formData = new FormData(form);
      const response = await fetch('/api/apply', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'X-Nocturne-Ajax': '1'
        },
        body: new URLSearchParams(formData).toString()
      });

      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(result.error || `Submission failed with status ${response.status}`);
      }

      window.location.assign('/application-received.html');
    } catch (error) {
      console.error('NOCTURNE application submission failed:', error);
      status.textContent = error.message || 'Your request could not be submitted. Please try again.';
      if (submitButton) submitButton.disabled = false;
    }
  });
}

const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const hero = document.querySelector('.hero');
if (hero) {
  requestAnimationFrame(() => hero.classList.add('cinematic-ready'));

  if (!reduceMotion && window.matchMedia('(pointer:fine)').matches) {
    let raf = 0;
    let nextX = 72;
    let nextY = 30;
    let nextPX = 0;
    let nextPY = 0;

    const renderHeroPointer = () => {
      raf = 0;
      hero.style.setProperty('--hero-light-x', `${nextX}%`);
      hero.style.setProperty('--hero-light-y', `${nextY}%`);
      hero.style.setProperty('--hero-parallax-x', `${nextPX}px`);
      hero.style.setProperty('--hero-parallax-y', `${nextPY}px`);
    };

    const queueHeroPointer = () => {
      if (!raf) raf = requestAnimationFrame(renderHeroPointer);
    };

    hero.addEventListener('pointermove', (event) => {
      const rect = hero.getBoundingClientRect();
      const x = Math.min(Math.max((event.clientX - rect.left) / rect.width, 0), 1);
      const y = Math.min(Math.max((event.clientY - rect.top) / rect.height, 0), 1);
      nextX = 58 + x * 26;
      nextY = 18 + y * 30;
      nextPX = (x - .5) * -10;
      nextPY = (y - .5) * -7;
      queueHeroPointer();
    }, { passive: true });

    hero.addEventListener('pointerleave', () => {
      nextX = 72;
      nextY = 30;
      nextPX = 0;
      nextPY = 0;
      queueHeroPointer();
    });
  }
}

const canvas = document.querySelector('#stars');
if (canvas && !reduceMotion) {
  const ctx = canvas.getContext('2d');
  let w, h, dpr, particles;
  const resize = () => {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = canvas.clientWidth;
    h = canvas.clientHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    particles = Array.from({ length: Math.min(130, Math.floor(w / 9)) }, () => ({
      x: Math.random() * w,
      y: Math.random() * h,
      r: Math.random() * 1.25 + .18,
      a: Math.random() * .58 + .12,
      s: Math.random() * .075 + .018,
      t: Math.random() * Math.PI * 2
    }));
  };
  const draw = () => {
    ctx.clearRect(0, 0, w, h);
    for (const p of particles) {
      p.y -= p.s;
      p.t += .012;
      if (p.y < -2) {
        p.y = h + 2;
        p.x = Math.random() * w;
      }
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      const twinkle = Math.max(.08, p.a + Math.sin(p.t) * .12);
      ctx.fillStyle = `rgba(255,202,97,${twinkle})`;
      ctx.fill();
    }
    requestAnimationFrame(draw);
  };
  resize();
  draw();
  window.addEventListener('resize', resize, { passive: true });
}
