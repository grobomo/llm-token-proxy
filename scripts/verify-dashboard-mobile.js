#!/usr/bin/env node
/**
 * Automated mobile UX verification for the dashboard.
 * Runs headless Chrome at 375px width, checks for common mobile layout issues.
 *
 * Usage: node scripts/verify-dashboard-mobile.js [--url http://127.0.0.1:4100/dashboard]
 *
 * Checks:
 *   1. No horizontal overflow (scrollWidth > clientWidth)
 *   2. Tooltips/modals don't clip outside viewport
 *   3. Touch targets >= 44px
 *   4. Text readable (font-size >= 11px)
 *   5. No elements wider than viewport
 *   6. Screenshot saved for visual review
 */

const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');

const URL = process.argv.find(a => a.startsWith('http')) || 'http://127.0.0.1:4100/dashboard';
const VIEWPORT = { width: 375, height: 812, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const SCREENSHOT_DIR = path.resolve(__dirname, '..', 'data', 'screenshots');

async function run() {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport(VIEWPORT);
  await page.goto(URL, { waitUntil: 'networkidle0', timeout: 15000 });
  await page.waitForSelector('.chart', { timeout: 10000 });

  const issues = [];

  // Check 1: Horizontal overflow (skip elements with intentional overflow-x: auto/scroll)
  const overflows = await page.evaluate(() => {
    const results = [];
    document.querySelectorAll('*').forEach(el => {
      if (el.scrollWidth > el.clientWidth + 2 && el.clientWidth > 0) {
        const style = getComputedStyle(el);
        if (style.overflowX === 'auto' || style.overflowX === 'scroll') return;
        const tag = el.tagName.toLowerCase();
        const cls = el.className ? `.${el.className.split(' ')[0]}` : '';
        const overflow = el.scrollWidth - el.clientWidth;
        if (overflow > 5) results.push({ el: `${tag}${cls}`, overflow });
      }
    });
    return results.slice(0, 10);
  });
  if (overflows.length > 0) {
    issues.push({ check: 'horizontal-overflow', severity: 'error', details: overflows });
  }

  // Check 2: Elements wider than viewport
  const widerThanVP = await page.evaluate((vpWidth) => {
    const results = [];
    document.querySelectorAll('div, section, table, .tooltip, .chart-container').forEach(el => {
      const rect = el.getBoundingClientRect();
      if (rect.width > vpWidth + 2) {
        const tag = el.tagName.toLowerCase();
        const cls = el.className ? `.${el.className.split(' ')[0]}` : '';
        results.push({ el: `${tag}${cls}`, width: Math.round(rect.width), vpWidth });
      }
    });
    return results.slice(0, 10);
  }, VIEWPORT.width);
  if (widerThanVP.length > 0) {
    issues.push({ check: 'wider-than-viewport', severity: 'error', details: widerThanVP });
  }

  // Check 3: Touch targets too small
  const smallTargets = await page.evaluate(() => {
    const results = [];
    document.querySelectorAll('button, a, select, input, [onclick], [role="button"], .bar-wrap').forEach(el => {
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        if (rect.width < 44 || rect.height < 44) {
          const tag = el.tagName.toLowerCase();
          const cls = el.className ? `.${el.className.split(' ')[0]}` : '';
          const text = (el.textContent || '').trim().slice(0, 20);
          results.push({ el: `${tag}${cls}`, text, w: Math.round(rect.width), h: Math.round(rect.height) });
        }
      }
    });
    return results.slice(0, 10);
  });
  if (smallTargets.length > 0) {
    issues.push({ check: 'small-touch-targets', severity: 'warn', details: smallTargets });
  }

  // Check 4: Simulate tooltip tap and check it's visible
  const tooltipCheck = await page.evaluate(() => {
    const bar = document.querySelector('.bar-wrap');
    if (!bar) return { ok: false, reason: 'no bar-wrap found' };

    // Simulate touch
    bar.dispatchEvent(new Event('touchstart', { bubbles: true }));
    bar.dispatchEvent(new Event('touchend', { bubbles: true }));

    // Check tooltip visibility
    const tip = document.querySelector('.tooltip[style*="display: block"], #chart-tooltip[style*="display: block"]');
    if (!tip) return { ok: true, reason: 'no tooltip shown (may need click handler)' };

    const rect = tip.getBoundingClientRect();
    const vpH = window.innerHeight;
    const vpW = window.innerWidth;

    if (rect.bottom > vpH) return { ok: false, reason: `tooltip clipped: bottom=${Math.round(rect.bottom)} > viewport=${vpH}` };
    if (rect.right > vpW) return { ok: false, reason: `tooltip clipped: right=${Math.round(rect.right)} > viewport=${vpW}` };
    if (rect.top < 0) return { ok: false, reason: `tooltip clipped: top=${Math.round(rect.top)} < 0` };

    return { ok: true, reason: `tooltip visible: ${Math.round(rect.width)}x${Math.round(rect.height)} at (${Math.round(rect.left)},${Math.round(rect.top)})` };
  });
  if (!tooltipCheck.ok) {
    issues.push({ check: 'tooltip-visibility', severity: 'error', details: tooltipCheck.reason });
  }

  // Check 5: Font sizes
  const smallFonts = await page.evaluate(() => {
    const results = [];
    document.querySelectorAll('*').forEach(el => {
      if (el.children.length === 0 && el.textContent.trim()) {
        const size = parseFloat(getComputedStyle(el).fontSize);
        if (size < 11 && size > 0) {
          const text = el.textContent.trim().slice(0, 30);
          results.push({ text, size: Math.round(size * 10) / 10 });
        }
      }
    });
    return results.slice(0, 10);
  });
  if (smallFonts.length > 0) {
    issues.push({ check: 'small-fonts', severity: 'warn', details: smallFonts });
  }

  // Screenshot
  const screenshotPath = path.join(SCREENSHOT_DIR, `mobile-${Date.now()}.png`);
  await page.screenshot({ path: screenshotPath, fullPage: true });

  // Report
  console.log('=' .repeat(60));
  console.log('  MOBILE UX VERIFICATION');
  console.log(`  URL: ${URL}`);
  console.log(`  Viewport: ${VIEWPORT.width}x${VIEWPORT.height}`);
  console.log('=' .repeat(60));
  console.log();

  const errors = issues.filter(i => i.severity === 'error');
  const warnings = issues.filter(i => i.severity === 'warn');

  if (errors.length === 0 && warnings.length === 0) {
    console.log('  ✓ ALL CHECKS PASSED');
  } else {
    if (errors.length > 0) {
      console.log(`  ✗ ${errors.length} ERROR(S):`);
      for (const e of errors) {
        console.log(`    [${e.check}]`);
        if (Array.isArray(e.details)) {
          for (const d of e.details) console.log(`      ${JSON.stringify(d)}`);
        } else {
          console.log(`      ${e.details}`);
        }
      }
    }
    if (warnings.length > 0) {
      console.log(`  ⚠ ${warnings.length} WARNING(S):`);
      for (const w of warnings) {
        console.log(`    [${w.check}]`);
        if (Array.isArray(w.details)) {
          for (const d of w.details.slice(0, 5)) console.log(`      ${JSON.stringify(d)}`);
        } else {
          console.log(`      ${w.details}`);
        }
      }
    }
  }

  console.log();
  console.log(`  Screenshot: ${screenshotPath}`);
  console.log();

  await browser.close();
  process.exit(errors.length > 0 ? 1 : 0);
}

run().catch(err => {
  console.error('FATAL:', err.message);
  process.exit(2);
});
