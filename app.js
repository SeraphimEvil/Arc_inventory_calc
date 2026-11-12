'use strict';

const BOOKMARKLET = `javascript:(async()=>{try{const r=await fetch('/api/me/stash',{headers:{'x-arctracker-client':'web/3.0.0'}});if(!r.ok)throw new Error('HTTP '+r.status);const j=await r.json();const cs=j.data.categories;const c=cs.find(x=>x.capacity!=null)||cs.find(x=>x.category===0)||cs[0];const mods=[];if(c.details)for(const d of Object.values(c.details))if(Array.isArray(d.a))for(const m of d.a)if(m)mods.push(m);const p={v:2,rev:j.data.stashRev,items:c.items,mods};const t=JSON.stringify(p);const ta=document.createElement('textarea');ta.value=t;ta.style.cssText='position:fixed;top:0;left:0;opacity:0';document.body.appendChild(ta);ta.focus();ta.select();const ok=document.execCommand('copy');ta.remove();alert(ok?'Скопировано: '+p.items.length+' стаков, '+mods.length+' модификаторов. Вставьте на странице и нажмите Сформировать.':'Не удалось скопировать. Данные выведены в консоль.');if(!ok)console.log(t)}catch(e){alert('Ошибка: '+e.message)}})()`;

const RARITY_ORDER = ['Common', 'Uncommon', 'Rare', 'Epic', 'Legendary'];
const PRICES_KEY = 'arc-prices';

const state = {
  rows: [],
  catalog: new Map(),
  prices: loadPrices(),
  sortKey: 'qty',
  sortDir: 'desc'
};

const el = {
  input: document.getElementById('input'),
  file: document.getElementById('file'),
  build: document.getElementById('build'),
  clear: document.getElementById('clear'),
  status: document.getElementById('status'),
  result: document.getElementById('result'),
  placeholder: document.getElementById('placeholder'),
  summary: document.getElementById('summary'),
  search: document.getElementById('search'),
  filterType: document.getElementById('filter-type'),
  filterRarity: document.getElementById('filter-rarity'),
  hideBlueprints: document.getElementById('hide-blueprints'),
  tbody: document.querySelector('#table tbody'),
  table: document.getElementById('table'),
  exportCsv: document.getElementById('export-csv'),
  exportJson: document.getElementById('export-json'),
  bookmarklet: document.getElementById('bookmarklet'),
  copyBookmarklet: document.getElementById('copy-bookmarklet'),
  priceItem: document.getElementById('price-item'),
  priceValue: document.getElementById('price-value'),
  priceSave: document.getElementById('price-save'),
  priceList: document.getElementById('price-list')
};

function setStatus(text, kind) {
  el.status.textContent = text || '';
  el.status.className = 'status' + (kind ? ' ' + kind : '');
}

function showResult(visible) {
  el.result.hidden = !visible;
  el.placeholder.hidden = visible;
}

function buildCatalog(items, base) {
  const map = base ? new Map(base) : new Map();
  for (const item of items) {
    if (!item || !item.id) continue;
    map.set(item.id, {
      name: item.name || item.id,
      type: item.type || '—',
      rarity: item.rarity || '—',
      image: item.image || item.imageFilename || null,
      stackSize: typeof item.stackSize === 'number' ? item.stackSize : null,
      isBlueprint: !!item.isBlueprint
    });
  }
  return map;
}

function isCatalogShape(value) {
  return Array.isArray(value) && value.length > 0 &&
    typeof value[0] === 'object' && value[0] !== null && !Array.isArray(value[0]);
}

function toPairs(list) {
  const pairs = [];
  for (const entry of list) {
    if (!Array.isArray(entry) || entry.length < 2) continue;
    const id = entry[0];
    const qty = Number(entry[1]);
    if (typeof id !== 'string' || !id || !Number.isFinite(qty) || qty <= 0) continue;
    pairs.push([id, qty]);
  }
  return pairs;
}

// Категория 0 — это "All items", а 1..9 — её разбивка по вкладкам.
// Складывать все категории нельзя: количества удвоятся.
function pickStashCategory(categories) {
  return categories.find(c => c && c.capacity != null) ||
    categories.find(c => c && c.category === 0) ||
    categories[0] || null;
}

// details[индекс].a — массив надетых на оружие модификаторов, null = пустой слот
function extractMods(details) {
  const mods = [];
  if (!details) return mods;
  for (const detail of Object.values(details)) {
    if (!detail || !Array.isArray(detail.a)) continue;
    for (const modId of detail.a) {
      if (typeof modId === 'string' && modId) mods.push(modId);
    }
  }
  return mods;
}

function parsePayload(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new Error('Это не корректный JSON: ' + err.message);
  }

  if (data && isCatalogShape(data.items)) {
    return { catalog: data.items };
  }

  if (data && data.data && Array.isArray(data.data.categories)) {
    const category = pickStashCategory(data.data.categories);
    if (!category) throw new Error('В ответе /api/me/stash не найдено ни одной категории.');
    const pairs = toPairs(category.items || []);
    const mods = extractMods(category.details);
    if (pairs.length || mods.length) return { pairs, mods };
    throw new Error('В ответе /api/me/stash не найдено ни одного предмета.');
  }

  if (data && Array.isArray(data.items)) {
    const pairs = toPairs(data.items);
    const mods = Array.isArray(data.mods) ? data.mods.filter(m => typeof m === 'string' && m) : [];
    if (pairs.length || mods.length) return { pairs, mods };
  }

  if (Array.isArray(data)) {
    const pairs = toPairs(data);
    if (pairs.length) return { pairs, mods: [] };
  }

  throw new Error('Неизвестный формат. Ожидается {"v":2,"items":[["id",5]],"mods":["id"]}, ответ /api/me/stash или массив пар [["id",5]].');
}

// Предметы и модификаторы складываются в один список по id:
// модификатор может лежать в стеше и одновременно стоять на оружии.
function aggregate(pairs, mods) {
  const map = new Map();

  for (const [id, qty] of pairs) {
    let entry = map.get(id);
    if (!entry) {
      entry = { id, qty: 0, stacks: 0, equipped: 0 };
      map.set(id, entry);
    }
    entry.qty += qty;
    entry.stacks += 1;
  }

  for (const id of mods || []) {
    let entry = map.get(id);
    if (!entry) {
      entry = { id, qty: 0, stacks: 0, equipped: 0 };
      map.set(id, entry);
    }
    entry.qty += 1;
    entry.equipped += 1;
  }

  const rows = [];
  for (const entry of map.values()) {
    const meta = state.catalog.get(entry.id) || {};
    rows.push({
      id: entry.id,
      qty: entry.qty,
      stacks: entry.stacks,
      equipped: entry.equipped,
      name: meta.name || entry.id,
      type: meta.type || '—',
      rarity: meta.rarity || '—',
      image: meta.image || null,
      stackSize: meta.stackSize ?? null,
      isBlueprint: !!meta.isBlueprint
    });
  }
  return rows;
}

function formatNumber(value) {
  return Number(value).toLocaleString('ru-RU');
}

function formatMoney(value) {
  return Number(value).toLocaleString('ru-RU', { maximumFractionDigits: 2 }) + ' Р';
}

function loadPrices() {
  try {
    const raw = localStorage.getItem(PRICES_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const prices = {};
    for (const [id, value] of Object.entries(parsed)) {
      const num = Number(value);
      if (typeof id === 'string' && id && Number.isFinite(num) && num > 0) prices[id] = num;
    }
    return prices;
  } catch (err) {
    return {};
  }
}

function savePrices() {
  try {
    localStorage.setItem(PRICES_KEY, JSON.stringify(state.prices));
  } catch (err) {
    setStatus('Не удалось сохранить цены в браузере: ' + err.message, 'error');
  }
}

function getPrice(id) {
  const value = state.prices[id];
  return typeof value === 'number' && value > 0 ? value : 0;
}

function rowTotal(row) {
  return getPrice(row.id) * row.qty;
}

function renderPriceList() {
  const entries = Object.entries(state.prices)
    .map(([id, price]) => {
      const meta = state.catalog.get(id);
      return { id, price, name: meta ? meta.name : id };
    })
    .sort((a, b) => a.name.localeCompare(b.name, 'ru'));

  if (!entries.length) {
    el.priceList.innerHTML = '<p class="hint small">Цены пока не заданы.</p>';
    return;
  }

  el.priceList.innerHTML = '';
  for (const entry of entries) {
    const item = document.createElement('div');
    item.className = 'price-row';

    const name = document.createElement('span');
    name.className = 'price-name';
    name.textContent = entry.name;
    name.title = entry.id;

    const value = document.createElement('span');
    value.className = 'price-value';
    value.textContent = formatMoney(entry.price);

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'price-remove';
    remove.textContent = '×';
    remove.title = 'Удалить цену';
    remove.setAttribute('aria-label', 'Удалить цену для ' + entry.name);
    remove.addEventListener('click', () => {
      delete state.prices[entry.id];
      savePrices();
      renderPriceList();
      renderSummary(state.rows);
      renderTable();
    });

    item.append(name, value, remove);
    el.priceList.appendChild(item);
  }
}

function fillPriceSelect() {
  const current = el.priceItem.value;
  el.priceItem.innerHTML = '';

  const rows = [...state.rows].sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  if (!rows.length) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = 'Сначала сформируйте таблицу';
    el.priceItem.appendChild(option);
    return;
  }

  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = 'Выберите предмет';
  el.priceItem.appendChild(placeholder);

  for (const row of rows) {
    const option = document.createElement('option');
    option.value = row.id;
    option.textContent = row.name;
    el.priceItem.appendChild(option);
  }

  if (rows.some(row => row.id === current)) el.priceItem.value = current;
}

function applyPrice() {
  const id = el.priceItem.value;
  if (!id) {
    setStatus('Выберите предмет из списка.', 'error');
    return;
  }

  const raw = el.priceValue.value.trim();
  const price = Number(raw);
  if (!raw || !Number.isFinite(price) || price <= 0) {
    setStatus('Введите цену больше нуля.', 'error');
    return;
  }

  state.prices[id] = price;
  savePrices();
  renderPriceList();
  renderSummary(state.rows);
  renderTable();

  const meta = state.catalog.get(id);
  setStatus('Цена сохранена: ' + (meta ? meta.name : id) + ' — ' + formatMoney(price) + ' за шт.', 'ok');
  el.priceValue.value = '';
}

function fillSelect(select, values, allLabel) {
  const current = select.value;
  select.innerHTML = '';
  const all = document.createElement('option');
  all.value = '';
  all.textContent = allLabel;
  select.appendChild(all);
  for (const value of values) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = value;
    select.appendChild(option);
  }
  if (values.includes(current)) select.value = current;
}

function refreshFilters() {
  const types = [...new Set(state.rows.map(r => r.type))].sort((a, b) => a.localeCompare(b, 'ru'));
  const rarities = [...new Set(state.rows.map(r => r.rarity))].sort((a, b) => {
    const ai = RARITY_ORDER.indexOf(a);
    const bi = RARITY_ORDER.indexOf(b);
    if (ai === -1 && bi === -1) return a.localeCompare(b, 'ru');
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  });
  fillSelect(el.filterType, types, 'Все типы');
  fillSelect(el.filterRarity, rarities, 'Все редкости');
}

function getVisibleRows() {
  const query = el.search.value.trim().toLowerCase();
  const type = el.filterType.value;
  const rarity = el.filterRarity.value;
  const hideBp = el.hideBlueprints.checked;

  let rows = state.rows.filter(row => {
    if (type && row.type !== type) return false;
    if (rarity && row.rarity !== rarity) return false;
    if (hideBp && row.isBlueprint) return false;
    if (query && !row.name.toLowerCase().includes(query) && !row.id.toLowerCase().includes(query)) return false;
    return true;
  });

  const key = state.sortKey;
  const dir = state.sortDir === 'asc' ? 1 : -1;
  const valueOf = (row, k) => {
    if (k === 'price') return getPrice(row.id);
    if (k === 'total') return rowTotal(row);
    return row[k];
  };
  rows.sort((a, b) => {
    let av = valueOf(a, key);
    let bv = valueOf(b, key);
    if (key === 'rarity') {
      av = RARITY_ORDER.indexOf(av);
      bv = RARITY_ORDER.indexOf(bv);
      if (av === -1) av = 99;
      if (bv === -1) bv = 99;
    }
    if (key === 'stackSize') {
      av = av ?? -1;
      bv = bv ?? -1;
    }
    if (typeof av === 'string' || typeof bv === 'string') {
      return String(av).localeCompare(String(bv), 'ru') * dir;
    }
    if (av === bv) return a.name.localeCompare(b.name, 'ru');
    return (av - bv) * dir;
  });

  return rows;
}

function renderSummary(rows) {
  const totalUnits = rows.reduce((sum, r) => sum + r.qty, 0);
  const totalStacks = rows.reduce((sum, r) => sum + r.stacks, 0);
  const blueprints = rows.filter(r => r.isBlueprint).length;
  const equipped = rows.reduce((sum, r) => sum + r.equipped, 0);
  const totalValue = rows.reduce((sum, r) => sum + rowTotal(r), 0);
  const priced = rows.filter(r => getPrice(r.id) > 0).length;

  const stats = [
    ['Предметов', formatNumber(rows.length)],
    ['Всего единиц', formatNumber(totalUnits)],
    ['Стаков', formatNumber(totalStacks)],
    ['Надето модов', formatNumber(equipped)],
    ['Блюпринтов', formatNumber(blueprints)],
    ['Общая сумма', formatMoney(totalValue)],
    ['С ценой', formatNumber(priced) + ' / ' + formatNumber(rows.length)]
  ];

  el.summary.innerHTML = stats.map(([label, value], index) =>
    '<div class="stat' + (index === 5 ? ' stat-money' : '') + '">' +
    '<span class="label">' + label + '</span><span class="value">' + value + '</span></div>'
  ).join('');
}

function renderTable() {
  const rows = getVisibleRows();
  el.tbody.innerHTML = '';

  if (!rows.length) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 10;
    td.className = 'empty';
    td.textContent = 'Ничего не найдено по текущим фильтрам.';
    tr.appendChild(td);
    el.tbody.appendChild(tr);
    return;
  }

  const fragment = document.createDocumentFragment();

  for (const row of rows) {
    const tr = document.createElement('tr');

    const tdIcon = document.createElement('td');
    tdIcon.className = 'col-icon';
    if (row.image) {
      const img = document.createElement('img');
      img.className = 'icon';
      img.src = row.image;
      img.alt = '';
      img.loading = 'lazy';
      img.referrerPolicy = 'no-referrer';
      img.onerror = () => {
        const fallback = document.createElement('div');
        fallback.className = 'icon-fallback';
        img.replaceWith(fallback);
      };
      tdIcon.appendChild(img);
    } else {
      const fallback = document.createElement('div');
      fallback.className = 'icon-fallback';
      tdIcon.appendChild(fallback);
    }
    tr.appendChild(tdIcon);

    const tdName = document.createElement('td');
    const nameSpan = document.createElement('span');
    nameSpan.className = 'name';
    nameSpan.textContent = row.name;
    tdName.appendChild(nameSpan);
    if (row.isBlueprint) {
      const badge = document.createElement('span');
      badge.className = 'bp-badge';
      badge.textContent = 'BP';
      tdName.appendChild(badge);
    }
    tr.appendChild(tdName);

    const tdType = document.createElement('td');
    tdType.textContent = row.type;
    tr.appendChild(tdType);

    const tdRarity = document.createElement('td');
    const raritySpan = document.createElement('span');
    raritySpan.className = 'rarity rarity-' + row.rarity;
    raritySpan.textContent = row.rarity;
    tdRarity.appendChild(raritySpan);
    tr.appendChild(tdRarity);

    const tdQty = document.createElement('td');
    tdQty.className = 'num qty';
    tdQty.textContent = formatNumber(row.qty);
    tr.appendChild(tdQty);

    const tdEquipped = document.createElement('td');
    tdEquipped.className = 'num equipped';
    tdEquipped.textContent = row.equipped ? formatNumber(row.equipped) : '—';
    tr.appendChild(tdEquipped);

    const tdStacks = document.createElement('td');
    tdStacks.className = 'num stacks';
    tdStacks.textContent = formatNumber(row.stacks);
    tr.appendChild(tdStacks);

    const tdStackSize = document.createElement('td');
    tdStackSize.className = 'num stack-size';
    tdStackSize.textContent = row.stackSize === null ? '—' : formatNumber(row.stackSize);
    tr.appendChild(tdStackSize);

    const price = getPrice(row.id);

    const tdPrice = document.createElement('td');
    tdPrice.className = 'num price' + (price ? '' : ' price-empty');
    tdPrice.textContent = price ? formatMoney(price) : '—';
    tr.appendChild(tdPrice);

    const tdTotal = document.createElement('td');
    tdTotal.className = 'num total' + (price ? '' : ' price-empty');
    tdTotal.textContent = price ? formatMoney(price * row.qty) : '—';
    tr.appendChild(tdTotal);

    fragment.appendChild(tr);
  }

  el.tbody.appendChild(fragment);
}

function updateSortIndicators() {
  for (const th of el.table.querySelectorAll('th.sortable')) {
    th.classList.remove('asc', 'desc');
    if (th.dataset.sort === state.sortKey) {
      th.classList.add(state.sortDir);
    }
  }
}

function build() {
  const text = el.input.value.trim();
  if (!text) {
    setStatus('Вставьте данные в поле выше.', 'error');
    return;
  }

  let parsed;
  try {
    parsed = parsePayload(text);
  } catch (err) {
    setStatus(err.message, 'error');
    showResult(false);
    return;
  }

  if (parsed.catalog) {
    state.catalog = buildCatalog(parsed.catalog, state.catalog);
    setStatus('Загружен справочник: ' + formatNumber(parsed.catalog.length) + ' предметов. Теперь вставьте данные стеша.', 'ok');
    return;
  }

  state.rows = aggregate(parsed.pairs, parsed.mods);
  if (!state.rows.length) {
    setStatus('Не найдено ни одного предмета с количеством больше нуля.', 'error');
    showResult(false);
    return;
  }

  refreshFilters();
  fillPriceSelect();
  renderPriceList();
  renderSummary(state.rows);
  renderTable();
  updateSortIndicators();
  showResult(true);

  const totalUnits = state.rows.reduce((sum, r) => sum + r.qty, 0);
  const mods = parsed.mods ? parsed.mods.length : 0;
  setStatus(
    'Готово: ' + formatNumber(state.rows.length) + ' позиций, ' +
    formatNumber(totalUnits) + ' единиц' +
    (mods ? ', из них ' + formatNumber(mods) + ' надетых модификаторов' : '') + '.',
    'ok'
  );
}

function download(filename, content, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportCsv() {
  const rows = getVisibleRows();
  if (!rows.length) {
    setStatus('Нечего экспортировать.', 'error');
    return;
  }
  const header = ['id', 'name', 'type', 'rarity', 'quantity', 'equipped', 'stacks', 'stackSize', 'isBlueprint', 'price', 'total'];
  const lines = [header.join(',')];
  for (const row of rows) {
    const price = getPrice(row.id);
    const cells = [
      row.id,
      row.name,
      row.type,
      row.rarity,
      row.qty,
      row.equipped,
      row.stacks,
      row.stackSize === null ? '' : row.stackSize,
      row.isBlueprint ? 'true' : 'false',
      price || '',
      price ? price * row.qty : ''
    ].map(value => {
      const text = String(value);
      return /[",\n;]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
    });
    lines.push(cells.join(','));
  }
  download('arc-stash.csv', '\uFEFF' + lines.join('\n'), 'text/csv;charset=utf-8');
  setStatus('CSV сохранён: ' + formatNumber(rows.length) + ' строк.', 'ok');
}

function exportJson() {
  const rows = getVisibleRows();
  if (!rows.length) {
    setStatus('Нечего экспортировать.', 'error');
    return;
  }
  const payload = {
    generatedAt: new Date().toISOString(),
    itemCount: rows.length,
    totalUnits: rows.reduce((sum, r) => sum + r.qty, 0),
    totalValue: rows.reduce((sum, r) => sum + rowTotal(r), 0),
    items: rows.map(row => {
      const price = getPrice(row.id);
      return {
        id: row.id,
        name: row.name,
        type: row.type,
        rarity: row.rarity,
        quantity: row.qty,
        equipped: row.equipped,
        stacks: row.stacks,
        stackSize: row.stackSize,
        isBlueprint: row.isBlueprint,
        price: price || null,
        total: price ? price * row.qty : null
      };
    })
  };
  download('arc-stash.json', JSON.stringify(payload, null, 2), 'application/json');
  setStatus('JSON сохранён: ' + formatNumber(rows.length) + ' предметов.', 'ok');
}

function copyText(text) {
  const area = document.createElement('textarea');
  area.value = text;
  area.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
  document.body.appendChild(area);
  area.focus();
  area.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch (err) {
    ok = false;
  }
  area.remove();
  return ok;
}

function initBookmarklet() {
  el.bookmarklet.setAttribute('href', BOOKMARKLET);

  el.bookmarklet.addEventListener('click', event => {
    event.preventDefault();
    if (copyText(BOOKMARKLET)) {
      setStatus('Код букмарклета скопирован. Вставьте его в адресную строку на arctracker.io/stash.', 'ok');
    } else {
      setStatus('Не удалось скопировать. Перетащите ссылку в панель закладок.', 'error');
    }
  });

  el.copyBookmarklet.addEventListener('click', () => {
    if (copyText(BOOKMARKLET)) {
      setStatus('Код букмарклета скопирован.', 'ok');
    } else {
      setStatus('Не удалось скопировать код.', 'error');
    }
  });
}

function init() {
  if (window.ARC_ITEMS && Array.isArray(window.ARC_ITEMS.items)) {
    state.catalog = buildCatalog(window.ARC_ITEMS.items);
  }

  initBookmarklet();

  el.file.addEventListener('change', () => {
    const file = el.file.files && el.file.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      el.input.value = String(reader.result || '');
      build();
    };
    reader.onerror = () => setStatus('Не удалось прочитать файл.', 'error');
    reader.readAsText(file, 'utf-8');
  });

  el.build.addEventListener('click', build);
  el.clear.addEventListener('click', () => {
    el.input.value = '';
    showResult(false);
    setStatus('');
    el.input.focus();
  });

  el.priceSave.addEventListener('click', applyPrice);
  el.priceValue.addEventListener('keydown', event => {
    if (event.key === 'Enter') {
      event.preventDefault();
      applyPrice();
    }
  });
  el.priceItem.addEventListener('change', () => {
    const price = getPrice(el.priceItem.value);
    el.priceValue.value = price ? String(price) : '';
    el.priceValue.focus();
  });

  el.search.addEventListener('input', renderTable);
  el.filterType.addEventListener('change', renderTable);
  el.filterRarity.addEventListener('change', renderTable);
  el.hideBlueprints.addEventListener('change', renderTable);

  for (const th of el.table.querySelectorAll('th.sortable')) {
    th.addEventListener('click', () => {
      const key = th.dataset.sort;
      if (state.sortKey === key) {
        state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
      } else {
        state.sortKey = key;
        state.sortDir = key === 'name' || key === 'type' || key === 'rarity' ? 'asc' : 'desc';
      }
      updateSortIndicators();
      renderTable();
    });
  }

  el.exportCsv.addEventListener('click', exportCsv);
  el.exportJson.addEventListener('click', exportJson);

  el.input.addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      build();
    }
  });

  renderPriceList();
}

init();
