/* ============================================
   BULLETPROOF AUTOMATIONS TRAINING
   Shared JavaScript
   ============================================ */

// ============================================
// SUPABASE CONFIGURATION
// Replace these with your public Supabase frontend values.
// These are safe for browser use. Never put service role keys or API secrets here.
// ============================================
const SUPABASE_URL = 'https://YOUR_PROJECT_REF.supabase.co';
const SUPABASE_ANON_KEY = 'YOUR_SUPABASE_ANON_PUBLIC_KEY';

let supabaseClient = null;

function initSupabase() {
    if (
        SUPABASE_URL.includes('YOUR_PROJECT_REF') ||
        SUPABASE_ANON_KEY.includes('YOUR_SUPABASE_ANON_PUBLIC_KEY')
    ) {
        return null;
    }

    if (typeof supabase !== 'undefined' && supabase.createClient) {
        supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
        return supabaseClient;
    }
    return null;
}

// ============================================
// MOBILE MENU
// ============================================
function initMobileMenu() {
    const btn = document.querySelector('.mobile-menu-btn');
    const nav = document.querySelector('.mobile-nav');
    if (!btn || !nav) return;

    btn.addEventListener('click', () => {
        nav.classList.toggle('active');
    });

    nav.querySelectorAll('a').forEach(link => {
        link.addEventListener('click', () => {
            nav.classList.remove('active');
        });
    });
}

// ============================================
// SCROLL REVEAL
// ============================================
function initScrollReveal() {
    const reveals = document.querySelectorAll('.reveal');
    if (!reveals.length) return;

    const observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                entry.target.classList.add('active');
            }
        });
    }, { threshold: 0.1, rootMargin: '0px 0px -40px 0px' });

    reveals.forEach(el => observer.observe(el));
}

// ============================================
// HEADER SCROLL EFFECT
// ============================================
function initHeaderScroll() {
    const header = document.querySelector('.site-header');
    if (!header) return;

    window.addEventListener('scroll', () => {
        if (window.pageYOffset > 80) {
            header.style.background = 'rgba(10, 10, 15, 0.97)';
        } else {
            header.style.background = 'rgba(10, 10, 15, 0.9)';
        }
    });
}

// ============================================
// SMOOTH SCROLL FOR ANCHORS
// ============================================
function initSmoothScroll() {
    document.querySelectorAll('a[href^="#"]').forEach(anchor => {
        anchor.addEventListener('click', function(e) {
            const href = this.getAttribute('href');
            if (href === '#') return;
            const target = document.querySelector(href);
            if (target) {
                e.preventDefault();
                target.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }
        });
    });
}

// ============================================
// TOAST NOTIFICATIONS
// ============================================
function showToast(message, type = 'success') {
    let toast = document.querySelector('.toast');
    if (!toast) {
        toast = document.createElement('div');
        toast.className = 'toast';
        document.body.appendChild(toast);
    }

    toast.textContent = message;
    toast.className = `toast toast-${type}`;

    requestAnimationFrame(() => {
        toast.classList.add('show');
    });

    setTimeout(() => {
        toast.classList.remove('show');
    }, 4000);
}

// ============================================
// GET URL PARAMETER
// ============================================
function getUrlParam(param) {
    const urlParams = new URLSearchParams(window.location.search);
    return urlParams.get(param) || '';
}

// ============================================
// FORMAT DATE
// ============================================
function formatDate(dateStr) {
    if (!dateStr) return '-';
    const d = new Date(dateStr);
    return d.toLocaleDateString('en-GB', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    });
}

// ============================================
// ESCAPE HTML
// ============================================
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text == null ? '' : String(text);
    return div.innerHTML;
}

function isDuplicateSignupError(error) {
    if (!error) return false;
    return error.code === '23505' || /duplicate|unique/i.test(error.message || '');
}

async function invokeOptionalFunction(sb, functionName, payload) {
    if (!sb || !sb.functions || !functionName) return;
    try {
        await sb.functions.invoke(functionName, { body: payload });
    } catch (error) {
        console.warn(`${functionName} function call failed`, error);
    }
}

// ============================================
// INIT ALL
// ============================================
document.addEventListener('DOMContentLoaded', () => {
    initSupabase();
    initMobileMenu();
    initScrollReveal();
    initHeaderScroll();
    initSmoothScroll();
});
