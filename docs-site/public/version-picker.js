/**
 * Version menu for the docs site. Loaded from /version-picker.js so
 * <base href> cannot rewrite it. Versions come from /versions.json at runtime.
 *
 * Path mapping and key handling match docs-site/src/lib/docs-versions.ts.
 */
(function (root) {
  'use strict'

  var VERSIONS_URL = '/versions.json'
  var OLDER_HREF = '/versions'
  var FROZEN_LIMIT = 5

  function normalizeVersionHref(href) {
    if (!href || href === '/') return '/'
    var value = href.charAt(0) === '/' ? href : '/' + href
    if (value.charAt(value.length - 1) !== '/') value += '/'
    return value
  }

  function mapDocsPath(currentPath, fromHref, toHref) {
    var from = normalizeVersionHref(fromHref)
    var to = normalizeVersionHref(toHref)
    var raw = currentPath || '/'
    var suffix = ''
    var query = raw.indexOf('?')
    var hash = raw.indexOf('#')
    var cut = -1
    if (query >= 0 && hash >= 0) cut = Math.min(query, hash)
    else if (query >= 0) cut = query
    else if (hash >= 0) cut = hash
    if (cut >= 0) {
      suffix = raw.slice(cut)
      raw = raw.slice(0, cut)
    }
    if (raw.charAt(0) !== '/') raw = '/' + raw

    var rest = raw
    if (from !== '/') {
      var prefix = from.slice(0, -1)
      if (rest === prefix || rest === prefix + '/') rest = '/'
      else if (rest.indexOf(prefix + '/') === 0) rest = rest.slice(prefix.length)
    }

    var mapped
    if (to === '/') mapped = rest
    else if (rest === '/') mapped = to
    else mapped = to.slice(0, -1) + rest
    return mapped + suffix
  }

  function pickerRows(versions, limit) {
    if (limit === undefined) limit = FROZEN_LIMIT
    var latest = []
    var frozen = []
    versions.forEach(function (entry) {
      if (entry.latest) latest.push(entry)
      else frozen.push(entry)
    })
    var rows = []
    latest.forEach(function (entry) {
      rows.push({ kind: 'version', entry: entry })
    })
    frozen.slice(0, limit).forEach(function (entry) {
      rows.push({ kind: 'version', entry: entry })
    })
    if (frozen.length > limit) rows.push({ kind: 'older', href: OLDER_HREF })
    return rows
  }

  function pickerKey(state, key) {
    if (key === 'Escape') {
      return { open: false, index: state.index, action: state.open ? 'close' : 'none' }
    }
    if (key === ' ' || key === 'Spacebar') {
      return { open: !state.open, index: state.index, action: state.open ? 'close' : 'open' }
    }
    if (key === 'Enter') {
      if (!state.open) return { open: true, index: state.index, action: 'open' }
      return { open: true, index: state.index, action: 'select' }
    }
    if (key === 'ArrowDown' || key === 'ArrowUp') {
      if (!state.open || state.count <= 0) {
        return { open: true, index: state.index, action: 'open' }
      }
      var delta = key === 'ArrowDown' ? 1 : -1
      var index = (state.index + delta) % state.count
      if (index < 0) index += state.count
      return { open: true, index: index, action: 'move' }
    }
    return { open: state.open, index: state.index, action: 'none' }
  }

  var api = {
    mapDocsPath: mapDocsPath,
    pickerRows: pickerRows,
    pickerKey: pickerKey,
    normalizeVersionHref: normalizeVersionHref,
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = api
  root.CastDocsVersions = api

  if (typeof document === 'undefined') return

  var PICKER_CSS = [
    '.brand-row{display:flex;align-items:center;gap:0.65rem;}',
    '.brand-row>a.brand{margin-bottom:0;}',
    '.landing-brand-group{display:inline-flex;align-items:center;gap:0.65rem;}',
    '.version-picker{position:relative;display:inline-block;vertical-align:middle;font-family:var(--font-mono);font-size:0.78rem;line-height:1.4;}',
    '.version-picker-button{margin:0;font-family:var(--font-mono);font-size:0.78rem;line-height:1.4;color:var(--color-fg);background:var(--color-bg-elevated);border:1px solid var(--color-border);border-radius:var(--radius);padding:0.12rem 0.45rem;cursor:pointer;display:inline-flex;align-items:center;gap:0.4rem;white-space:nowrap;}',
    '.version-picker-latest{color:var(--color-fg-muted);font-weight:400;}',
    '.version-picker-menu{position:absolute;z-index:30;top:calc(100% + 4px);left:0;min-width:12rem;margin:0;padding:0.25rem 0;list-style:none;background:var(--color-bg-elevated);color:var(--color-fg);border:1px solid var(--color-border);border-radius:var(--radius);box-shadow:var(--shadow);}',
    '.version-picker-menu[hidden]{display:none;}',
    '.version-picker-menu li{margin:0;}',
    '.version-picker-menu a,.sidebar .version-picker-menu a{display:flex;align-items:center;justify-content:space-between;gap:0.75rem;padding:0.3rem 0.65rem;color:var(--color-fg);text-decoration:none;font-family:var(--font-mono);font-size:0.78rem;white-space:nowrap;background:transparent;}',
    '.version-picker-menu a:hover,.sidebar .version-picker-menu a:hover,.version-picker-menu li.is-highlighted a,.sidebar .version-picker-menu li.is-highlighted a{background:var(--color-bg-muted);color:var(--color-fg);text-decoration:none;}',
    '.version-picker-menu li.is-current a{font-weight:700;}',
    '.version-picker-mark{color:var(--color-fg);font-weight:700;}',
  ].join('')

  function ensureStyles() {
    if (document.getElementById('version-picker-styles')) return
    var style = document.createElement('style')
    style.id = 'version-picker-styles'
    style.textContent = PICKER_CSS
    document.head.appendChild(style)
  }

  function pageVersion(mount) {
    var value = mount.getAttribute('data-docs-version')
      || document.documentElement.getAttribute('data-docs-version')
      || ''
    return value.replace(/^v/, '')
  }

  function fillButton(button, version, isLatest) {
    button.textContent = ''
    button.appendChild(document.createTextNode('v' + version))
    if (isLatest) {
      var mark = document.createElement('span')
      mark.className = 'version-picker-latest'
      mark.textContent = 'Latest'
      button.appendChild(mark)
    }
  }

  function menuRows(manifest, version, pathname) {
    var from = '/'
    manifest.versions.forEach(function (entry) {
      if (entry.version === version) from = entry.href
    })
    return pickerRows(manifest.versions).map(function (row) {
      if (row.kind === 'older') {
        return { label: 'Older versions', href: row.href, current: false, latest: false }
      }
      return {
        label: row.entry.label,
        href: mapDocsPath(pathname, from, row.entry.href),
        current: row.entry.version === version,
        latest: !!row.entry.latest,
      }
    })
  }

  function initPicker(mount, manifest) {
    if (mount.getAttribute('data-version-picker-ready') === 'true') return
    mount.setAttribute('data-version-picker-ready', 'true')
    var version = pageVersion(mount)
    var pathname = window.location.pathname + window.location.search + window.location.hash
    var rows = menuRows(manifest, version, pathname)
    var button = mount.querySelector('button')
    if (!button) {
      button = document.createElement('button')
      button.type = 'button'
      button.className = 'version-picker-button'
      button.setAttribute('aria-haspopup', 'listbox')
      mount.insertBefore(button, mount.firstChild)
    }
    button.setAttribute('aria-expanded', 'false')
    button.setAttribute('aria-controls', 'version-picker-menu')
    fillButton(button, version, version === manifest.latest)

    var currentIndex = 0
    rows.forEach(function (row, index) {
      if (row.current) currentIndex = index
    })
    var state = { open: false, index: currentIndex, count: rows.length }

    var menu = document.createElement('ul')
    menu.className = 'version-picker-menu'
    menu.id = 'version-picker-menu'
    menu.setAttribute('role', 'listbox')
    menu.hidden = true
    rows.forEach(function (row, index) {
      var li = document.createElement('li')
      li.id = 'version-picker-opt-' + index
      li.setAttribute('role', 'option')
      if (row.current) {
        li.setAttribute('aria-current', 'true')
        li.classList.add('is-current')
      }
      var link = document.createElement('a')
      link.href = row.href
      link.setAttribute('data-index', String(index))
      if (row.current) {
        var mark = document.createElement('span')
        mark.className = 'version-picker-mark'
        mark.setAttribute('aria-hidden', 'true')
        mark.textContent = '\u2713'
        link.appendChild(mark)
      }
      var label = document.createElement('span')
      label.textContent = row.label
      link.appendChild(label)
      if (row.latest) {
        var latest = document.createElement('span')
        latest.className = 'version-picker-latest'
        latest.textContent = 'Latest'
        link.appendChild(latest)
      }
      li.appendChild(link)
      menu.appendChild(li)
    })
    mount.appendChild(menu)

    function paint() {
      button.setAttribute('aria-expanded', state.open ? 'true' : 'false')
      menu.hidden = !state.open
      var options = menu.querySelectorAll('[role="option"]')
      for (var i = 0; i < options.length; i++) {
        var on = i === state.index
        options[i].setAttribute('aria-selected', on ? 'true' : 'false')
        options[i].classList.toggle('is-highlighted', on)
      }
      if (state.open && options[state.index]) {
        button.setAttribute('aria-activedescendant', options[state.index].id)
      } else {
        button.removeAttribute('aria-activedescendant')
      }
    }

    function apply(next) {
      state.open = next.open
      state.index = next.index
      paint()
      if (next.action === 'select') {
        var href = rows[state.index] && rows[state.index].href
        if (href) window.location.assign(href)
      }
    }

    button.addEventListener('keydown', function (event) {
      var key = event.key
      if (key !== 'Enter' && key !== ' ' && key !== 'Spacebar' && key !== 'ArrowDown' && key !== 'ArrowUp' && key !== 'Escape') {
        return
      }
      event.preventDefault()
      apply(pickerKey(state, key))
    })
    button.addEventListener('click', function () {
      apply(pickerKey(state, ' '))
    })
    menu.addEventListener('mouseover', function (event) {
      var link = event.target.closest ? event.target.closest('a') : null
      if (!link || !menu.contains(link)) return
      var index = Number(link.getAttribute('data-index'))
      if (!Number.isFinite(index)) return
      state.index = index
      paint()
    })
    document.addEventListener('mousedown', function (event) {
      if (!state.open || mount.contains(event.target)) return
      apply(pickerKey(state, 'Escape'))
    })
    paint()
  }

  function renderVersionsPage(manifest) {
    var rootList = document.querySelector('[data-versions-index]')
    if (!rootList) return
    rootList.textContent = ''
    manifest.versions.forEach(function (entry) {
      if (entry.latest) return
      var li = document.createElement('li')
      var link = document.createElement('a')
      link.href = entry.href
      link.textContent = entry.label
      li.appendChild(link)
      rootList.appendChild(li)
    })
  }

  function boot() {
    var mounts = document.querySelectorAll('[data-version-picker]')
    var index = document.querySelector('[data-versions-index]')
    if (!mounts.length && !index) return
    ensureStyles()
    fetch(VERSIONS_URL).then(function (response) {
      if (!response.ok) throw new Error('versions.json ' + response.status)
      return response.json()
    }).then(function (manifest) {
      if (!manifest || !manifest.versions) return
      mounts.forEach(function (mount) { initPicker(mount, manifest) })
      renderVersionsPage(manifest)
    }).catch(function () {})
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot)
  else boot()
})(typeof globalThis !== 'undefined' ? globalThis : this)
