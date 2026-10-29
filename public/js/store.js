/**
 * Sugarcube Corner — Camada de Dados Híbrida (Servidor Python Local + GitHub Pages Estático + GitHub Cloud Commit)
 * - Funciona localmente com server.py (SQLite + Cookie HttpOnly)
 * - Funciona 100% estático no GitHub Pages (lendo data/public.json)
 * - Permite que Kai cadastre/edite bolos, confeitarias e fotos direto pelo navegador no GitHub Pages
 *   fazendo commit automático via API oficial do GitHub (sem precisar de computador ligado!)
 */

const REACTED_STORAGE_KEY = 'sugarcube_visitor_reactions_v1';
const LOCAL_REACTION_COUNTS_KEY = 'sugarcube_visitor_reaction_counts_v1';
const VOTED_STORAGE_KEY = 'sugarcube_visitor_votes_v1';
const LOCAL_VOTE_COUNTS_KEY = 'sugarcube_visitor_vote_counts_v1';
const LOCAL_SUGGESTIONS_KEY = 'sugarcube_visitor_suggestions_v1';
const ADMIN_DRAFT_CAKE_KEY = 'sugarcube_admin_draft_cake_v1';
const GH_SESSION_STORAGE_KEY = 'sugarcube_gh_admin_session_v1';

// Detecta automaticamente o caminho-base do site (ex: "" na raiz ou "/nome-do-repo" no GitHub Pages)
const SITE_ROOT_URL = new URL('..', import.meta.url);
export const SITE_BASE_PATH = SITE_ROOT_URL.pathname.replace(/\/$/, '');

export function resolveSitePath(pathStr) {
  if (!pathStr || typeof pathStr !== 'string') return pathStr;
  if (
    pathStr.startsWith('http://') ||
    pathStr.startsWith('https://') ||
    pathStr.startsWith('data:') ||
    pathStr.startsWith('mailto:') ||
    pathStr.startsWith('tel:') ||
    pathStr.startsWith('#')
  ) {
    return pathStr;
  }
  const clean = pathStr.startsWith('/') ? pathStr : `/${pathStr}`;
  if (SITE_BASE_PATH && (clean === SITE_BASE_PATH || clean.startsWith(`${SITE_BASE_PATH}/`))) {
    return clean;
  }
  return `${SITE_BASE_PATH}${clean}`;
}

let staticPagesMode = false;

let appState = {
  settings: {
    siteName: 'Sugarcube Corner',
    subtitle: 'O guia autoral de bolos e confeitarias de Feira de Santana, por Kai Tavares',
    city: 'Feira de Santana',
    state: 'BA',
    approvalThreshold: 8.5,
    minTextureForApproval: 8.0,
    minCakesForConsolidatedRank: 2,
    weights: { flavor: 25, dough: 25, texture: 25, filling: 25 },
    kaiBio: {}
  },
  bakeries: [],
  cakes: [],
  upcomingBakeries: [],
  publicSuggestions: []
};

let adminSession = {
  authenticated: false,
  username: null,
  mode: 'server', // 'server' | 'github'
  githubRepo: '',
  githubBranch: 'main',
  githubToken: ''
};

export function isStaticPagesMode() {
  return staticPagesMode;
}

export function getAdminSessionInfo() {
  return {
    authenticated: adminSession.authenticated,
    username: adminSession.username,
    mode: adminSession.mode,
    githubRepo: adminSession.githubRepo,
    githubBranch: adminSession.githubBranch
  };
}

export function detectDefaultGitHubRepo() {
  const host = window.location.hostname;
  if (host.endsWith('.github.io')) {
    const owner = host.replace('.github.io', '');
    const pathSeg = SITE_BASE_PATH.replace(/^\//, '').split('/')[0];
    if (pathSeg) {
      return `${owner}/${pathSeg}`;
    }
    return `${owner}/${owner}.github.io`;
  }
  return 'lieRp/kai_avalia';
}

function slugifyClient(text) {
  const normalized = String(text || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
  return normalized.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'item';
}

function applyLocalVisitorOverlays(stateObj) {
  if (!stateObj) return stateObj;
  try {
    const reactCounts = JSON.parse(localStorage.getItem(LOCAL_REACTION_COUNTS_KEY) || '{}');
    const voteCounts = JSON.parse(localStorage.getItem(LOCAL_VOTE_COUNTS_KEY) || '{}');
    (stateObj.cakes || []).forEach((c) => {
      if (!c.reactions) c.reactions = { waterInMouth: 0, agreeWithKai: 0, wantToTry: 0 };
      ['waterInMouth', 'agreeWithKai', 'wantToTry'].forEach((k) => {
        const extra = Number(reactCounts[`${c.id}:${k}`] || 0);
        if (extra > 0) c.reactions[k] = Number(c.reactions[k] || 0) + extra;
      });
    });
    (stateObj.upcomingBakeries || []).forEach((u) => {
      const extra = Number(voteCounts[u.id] || 0);
      if (extra > 0) u.votes = Number(u.votes || 0) + extra;
    });
  } catch (_) {}
  return stateObj;
}

async function apiRequest(url, options = {}) {
  const fullUrl = resolveSitePath(url);
  let res;
  try {
    res = await fetch(fullUrl, {
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        ...(options.headers || {})
      },
      ...options
    });
  } catch (networkErr) {
    throw new Error('Falha de conexão com o servidor.');
  }

  let json = {};
  try {
    json = await res.json();
  } catch (_) {
    throw new Error(`Resposta inesperada do servidor (HTTP ${res.status}).`);
  }

  if (!res.ok || json.ok === false) {
    throw new Error(json.error || `Erro na operação (HTTP ${res.status}).`);
  }

  return json;
}

/* ==========================================================================
   INTEGRAÇÃO DIRETA COM A API DO GITHUB (MODO NUVEM SEM SERVIDOR PYTHON)
   ========================================================================== */
function encodeBase64Utf8(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function decodeBase64Utf8(b64) {
  const clean = String(b64 || '').replace(/\s+/g, '');
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new TextDecoder('utf-8').decode(bytes);
}

async function githubApiRequest(endpoint, options = {}) {
  const token = options.token || adminSession.githubToken;
  const headers = {
    Accept: 'application/vnd.github+json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(options.headers || {})
  };
  const res = await fetch(`https://api.github.com${endpoint}`, {
    ...options,
    headers
  });
  let data = {};
  try {
    data = await res.json();
  } catch (_) {}
  if (!res.ok) {
    throw new Error(data.message || `Erro na API do GitHub (HTTP ${res.status}).`);
  }
  return data;
}

async function githubPutFile(repo, branch, filePath, contentB64, commitMessage) {
  let existingSha = null;
  try {
    const existing = await githubApiRequest(
      `/repos/${repo}/contents/${filePath}?ref=${encodeURIComponent(branch)}`
    );
    if (existing && existing.sha) {
      existingSha = existing.sha;
    }
  } catch (_) {
    // Arquivo ainda não existe no repositório
  }

  const body = {
    message: commitMessage,
    content: contentB64,
    branch
  };
  if (existingSha) {
    body.sha = existingSha;
  }

  return await githubApiRequest(`/repos/${repo}/contents/${filePath}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
}

async function commitStateToGitHub(commitMessage) {
  if (!adminSession.authenticated || adminSession.mode !== 'github') {
    throw new Error('Faça login com seu Token do GitHub no painel para publicar alterações.');
  }
  const cleanPayload = {
    settings: appState.settings,
    bakeries: appState.bakeries || [],
    cakes: appState.cakes || [],
    upcomingBakeries: appState.upcomingBakeries || [],
    publicSuggestions: appState.publicSuggestions || []
  };
  const jsonStr = JSON.stringify(cleanPayload, null, 2);
  const b64 = encodeBase64Utf8(jsonStr);

  // Salva em public/data/public.json, data/seed.json e docs/data/public.json
  await githubPutFile(
    adminSession.githubRepo,
    adminSession.githubBranch,
    'public/data/public.json',
    b64,
    commitMessage
  );
  await githubPutFile(
    adminSession.githubRepo,
    adminSession.githubBranch,
    'data/seed.json',
    b64,
    `${commitMessage} (sync seed)`
  );
  try {
    await githubPutFile(
      adminSession.githubRepo,
      adminSession.githubBranch,
      'docs/data/public.json',
      b64,
      `${commitMessage} (sync docs)`
    );
  } catch (_) {}
}

/* ==========================================================================
   CARREGAMENTO DE DADOS PÚBLICOS (SERVIDOR LOCAL OU GITHUB PAGES ESTÁTICO)
   ========================================================================== */
export async function refreshPublicData() {
  const isGithubDomain =
    window.location.hostname.endsWith('.github.io') ||
    window.location.hostname.endsWith('kaiavalia.com.br');

  if (!isGithubDomain && !staticPagesMode) {
    try {
      const json = await apiRequest('/api/public/data', { method: 'GET' });
      if (json.data) {
        appState = json.data;
        return appState;
      }
    } catch (_) {
      staticPagesMode = true;
    }
  } else {
    staticPagesMode = true;
  }

  // Se estiver autenticado via GitHub API, busca a versão mais recente direto do repositório
  if (adminSession.authenticated && adminSession.mode === 'github' && adminSession.githubRepo) {
    try {
      const fileObj = await githubApiRequest(
        `/repos/${adminSession.githubRepo}/contents/public/data/public.json?ref=${encodeURIComponent(
          adminSession.githubBranch
        )}`
      );
      if (fileObj && fileObj.content) {
        const parsed = JSON.parse(decodeBase64Utf8(fileObj.content));
        appState = applyLocalVisitorOverlays(parsed);
        return appState;
      }
    } catch (_) {}
  }

  // Fallback estático: carrega data/public.json
  try {
    const staticUrl = `${resolveSitePath('/data/public.json')}?t=${Date.now()}`;
    const res = await fetch(staticUrl, { cache: 'no-store' });
    if (res.ok) {
      const parsed = await res.json();
      appState = applyLocalVisitorOverlays(parsed.data || parsed);
    }
  } catch (_) {}

  return appState;
}

export async function checkAdminSession() {
  if (!staticPagesMode && !window.location.hostname.endsWith('.github.io')) {
    try {
      const json = await apiRequest('/api/auth/me', { method: 'GET' });
      adminSession = {
        authenticated: Boolean(json.authenticated),
        username: json.username || null,
        mode: 'server',
        githubRepo: '',
        githubBranch: 'main',
        githubToken: ''
      };
      return adminSession;
    } catch (_) {
      staticPagesMode = true;
    }
  }

  // Verificar se há sessão GitHub salva no sessionStorage do navegador
  try {
    const saved = JSON.parse(sessionStorage.getItem(GH_SESSION_STORAGE_KEY) || 'null');
    if (saved && saved.githubToken && saved.githubRepo) {
      adminSession = {
        authenticated: true,
        username: saved.username || 'kai (GitHub)',
        mode: 'github',
        githubRepo: saved.githubRepo,
        githubBranch: saved.githubBranch || 'main',
        githubToken: saved.githubToken
      };
      return adminSession;
    }
  } catch (_) {}

  adminSession = {
    authenticated: false,
    username: null,
    mode: staticPagesMode ? 'github' : 'server',
    githubRepo: detectDefaultGitHubRepo(),
    githubBranch: 'main',
    githubToken: ''
  };
  return adminSession;
}

export async function initStore() {
  await refreshPublicData();
  await checkAdminSession();
  return appState;
}

export function getState() {
  return appState;
}

export function isAdminLoggedIn() {
  return Boolean(adminSession.authenticated);
}

/* ==========================================================================
   CÁLCULO DE NOTAS (ARREDONDAMENTO A 1 CASA DECIMAL CONSISTENTE COM O SELO)
   ========================================================================== */
export function computeCakeFinalScore(cake, customWeights = null) {
  const weights = customWeights || appState?.settings?.weights || {
    flavor: 25,
    dough: 25,
    texture: 25,
    filling: 25
  };

  const wFlavor = Number(weights.flavor) || 0;
  const wDough = Number(weights.dough) || 0;
  const wTexture = Number(weights.texture) || 0;
  const wFilling = Number(weights.filling) || 0;
  const totalWeight = wFlavor + wDough + wTexture + wFilling || 100;

  const sFlavor = Number(cake.scoreFlavor) || 0;
  const sDough = Number(cake.scoreDough) || 0;
  const sTexture = Number(cake.scoreTexture) || 0;
  const sFilling = Number(cake.scoreFilling) || 0;

  const weighted =
    (sFlavor * wFlavor +
      sDough * wDough +
      sTexture * wTexture +
      sFilling * wFilling) /
    totalWeight;

  return Math.round(weighted * 10) / 10;
}

export function isCakeApprovedByKai(cake, finalScore = null) {
  const score = finalScore !== null ? finalScore : computeCakeFinalScore(cake);
  const threshold = Math.round(Number(appState?.settings?.approvalThreshold ?? 8.5) * 10) / 10;
  const minTexture = Math.round(Number(appState?.settings?.minTextureForApproval ?? 8.0) * 10) / 10;
  const cakeTex = Math.round(Number(cake.scoreTexture || 0) * 10) / 10;
  return score >= threshold && cakeTex >= minTexture;
}

export function isDateOlderThanSixMonths(isoDate) {
  if (!isoDate) return false;
  const visitedTime = Date.parse(isoDate);
  if (Number.isNaN(visitedTime)) return false;
  const diffDays = (Date.now() - visitedTime) / (1000 * 60 * 60 * 24);
  return diffDays > 180;
}

export function getEnrichedCakes(customWeights = null) {
  if (!appState) return [];
  const bakeriesMap = new Map((appState.bakeries || []).map((b) => [b.id, b]));

  return (appState.cakes || []).map((cake) => {
    const bakery = bakeriesMap.get(cake.bakeryId) || {
      id: cake.bakeryId,
      name: 'Confeitaria',
      neighborhood: 'Feira de Santana',
      priceRange: '$$',
      slug: ''
    };
    const finalScore = computeCakeFinalScore(cake, customWeights);
    const kaiApproved = isCakeApprovedByKai(cake, finalScore);
    const latestVisit = cake.reevaluatedAt || cake.visitedAt;
    const isStale = isDateOlderThanSixMonths(latestVisit);

    return {
      ...cake,
      finalScore,
      kaiApproved,
      latestVisit,
      isStale,
      bakery
    };
  });
}

export function getEnrichedBakeries(customWeights = null) {
  if (!appState) return [];
  const enrichedCakes = getEnrichedCakes(customWeights);
  const minCakes = Number(appState?.settings?.minCakesForConsolidatedRank ?? 2);

  const allScores = enrichedCakes.map((c) => c.finalScore);
  const globalMean =
    allScores.length > 0
      ? allScores.reduce((acc, v) => acc + v, 0) / allScores.length
      : 8.0;

  return (appState.bakeries || []).map((bakery) => {
    const bCakes = enrichedCakes
      .filter((c) => c.bakeryId === bakery.id)
      .sort((a, b) => b.finalScore - a.finalScore);

    const count = bCakes.length;
    if (count === 0) {
      return {
        ...bakery,
        cakes: [],
        cakesCount: 0,
        overallScore: 0,
        rankingScore: 0,
        isConsolidated: false,
        lastVisitedAt: null,
        isStale: false,
        avgFlavor: 0,
        avgDough: 0,
        avgTexture: 0,
        avgFilling: 0,
        kaiApproved: false,
        bestCake: null
      };
    }

    const sum = (key) => bCakes.reduce((acc, item) => acc + Number(item[key] || 0), 0);
    const overallScore = Math.round((sum('finalScore') / count) * 10) / 10;
    const avgFlavor = Math.round((sum('scoreFlavor') / count) * 10) / 10;
    const avgDough = Math.round((sum('scoreDough') / count) * 10) / 10;
    const avgTexture = Math.round((sum('scoreTexture') / count) * 10) / 10;
    const avgFilling = Math.round((sum('scoreFilling') / count) * 10) / 10;

    const bayesian =
      (count * overallScore + minCakes * globalMean) / (count + minCakes);
    const rankingScore = Math.round(bayesian * 100) / 100;
    const isConsolidated = count >= minCakes;

    const threshold = Math.round(Number(appState?.settings?.approvalThreshold ?? 8.5) * 10) / 10;
    const minTexture = Math.round(Number(appState?.settings?.minTextureForApproval ?? 8.0) * 10) / 10;
    const kaiApproved = isConsolidated && overallScore >= threshold && avgTexture >= minTexture;

    const dates = bCakes
      .map((c) => c.reevaluatedAt || c.visitedAt)
      .filter(Boolean)
      .sort((a, b) => b.localeCompare(a));
    const lastVisitedAt = dates[0] || null;
    const isStale = isDateOlderThanSixMonths(lastVisitedAt);

    return {
      ...bakery,
      cakes: bCakes,
      cakesCount: count,
      overallScore,
      rankingScore,
      isConsolidated,
      lastVisitedAt,
      isStale,
      avgFlavor,
      avgDough,
      avgTexture,
      avgFilling,
      kaiApproved,
      bestCake: bCakes[0]
    };
  });
}

/* ==========================================================================
   AUTENTICAÇÃO (SERVIDOR LOCAL OU TOKEN GITHUB NO GITHUB PAGES)
   ========================================================================== */
export async function loginAdmin(username, password) {
  const json = await apiRequest('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username, password })
  });
  adminSession = {
    authenticated: true,
    username: json.username || username,
    mode: 'server',
    githubRepo: '',
    githubBranch: 'main',
    githubToken: ''
  };
  return true;
}

export async function loginAdminWithGitHub(repoFullName, token, branchInput = '') {
  const cleanRepo = String(repoFullName || '')
    .trim()
    .replace(/^https?:\/\/github\.com\//i, '')
    .replace(/\.git$/i, '')
    .replace(/^\/+|\/+$/g, '');
  const cleanToken = String(token || '').trim();

  if (!cleanRepo.includes('/')) {
    throw new Error('Informe o repositório no formato usuario/nome-do-repositorio.');
  }
  if (!cleanToken) {
    throw new Error('Informe o seu Personal Access Token do GitHub.');
  }

  const repoInfo = await githubApiRequest(`/repos/${cleanRepo}`, { token: cleanToken });
  if (repoInfo.permissions && !repoInfo.permissions.push) {
    throw new Error('Este Token não tem permissão de escrita (Contents: Read & Write) neste repositório.');
  }

  const targetBranch = String(branchInput || repoInfo.default_branch || 'main').trim();

  adminSession = {
    authenticated: true,
    username: repoInfo.owner?.login || 'kai',
    mode: 'github',
    githubRepo: cleanRepo,
    githubBranch: targetBranch,
    githubToken: cleanToken
  };

  try {
    sessionStorage.setItem(GH_SESSION_STORAGE_KEY, JSON.stringify(adminSession));
  } catch (_) {}

  await refreshPublicData();
  return true;
}

export async function logoutAdmin() {
  if (adminSession.mode === 'github' || staticPagesMode) {
    try {
      sessionStorage.removeItem(GH_SESSION_STORAGE_KEY);
    } catch (_) {}
    adminSession = {
      authenticated: false,
      username: null,
      mode: 'github',
      githubRepo: detectDefaultGitHubRepo(),
      githubBranch: 'main',
      githubToken: ''
    };
    return;
  }
  await apiRequest('/api/auth/logout', { method: 'POST' });
  adminSession = { authenticated: false, username: null, mode: 'server' };
}

export async function changeAdminPassword(currentPassword, newPassword) {
  if (staticPagesMode || adminSession.mode === 'github') {
    throw new Error('No modo GitHub Pages, o acesso usa seu Token do GitHub (gerenciado em github.com/settings/tokens).');
  }
  return await apiRequest('/api/auth/password', {
    method: 'POST',
    body: JSON.stringify({ currentPassword, newPassword })
  });
}

/* ==========================================================================
   OPERAÇÕES ADMIN PROTEGIDAS (CONFEITARIAS, BOLOS, CONFIGURAÇÕES)
   ========================================================================== */
export async function saveBakery(bakeryData) {
  if (staticPagesMode || adminSession.mode === 'github') {
    const name = String(bakeryData.name || '').trim();
    const neighborhood = String(bakeryData.neighborhood || '').trim();
    if (!name || !neighborhood) throw new Error('Informe nome e bairro da confeitaria.');

    const list = [...(appState.bakeries || [])];
    const isEdit = Boolean(bakeryData.id);
    const id = bakeryData.id || `bak-${Date.now()}`;
    const baseSlug = slugifyClient(`${name}-${neighborhood}`);
    let slug = baseSlug;
    let c = 2;
    while (list.some((b) => b.slug === slug && b.id !== id)) {
      slug = `${baseSlug}-${c++}`;
    }

    const record = {
      id,
      slug,
      name,
      neighborhood,
      address: String(bakeryData.address || '').trim(),
      lat: Number(bakeryData.lat || -12.2545),
      lng: Number(bakeryData.lng || -38.955),
      instagram: String(bakeryData.instagram || '').trim(),
      whatsapp: String(bakeryData.whatsapp || '').trim(),
      openingHours: String(bakeryData.openingHours || '').trim(),
      priceRange: String(bakeryData.priceRange || '$$'),
      coverPhoto: String(bakeryData.coverPhoto || '').trim(),
      description: String(bakeryData.description || '').trim(),
      isFeaturedPartner: Boolean(bakeryData.isFeaturedPartner),
      createdAt: bakeryData.createdAt || new Date().toISOString().slice(0, 10)
    };

    const idx = list.findIndex((b) => b.id === id);
    if (idx >= 0) list[idx] = record;
    else list.push(record);

    appState.bakeries = list;
    await commitStateToGitHub(`🧁 ${isEdit ? 'Atualiza' : 'Cadastra'} confeitaria: ${name}`);
    return { ok: true, id, slug };
  }

  const isEdit = Boolean(bakeryData.id);
  const url = isEdit
    ? `/api/admin/bakeries/${encodeURIComponent(bakeryData.id)}`
    : '/api/admin/bakeries';
  const method = isEdit ? 'PUT' : 'POST';

  const res = await apiRequest(url, {
    method,
    body: JSON.stringify(bakeryData)
  });
  await refreshPublicData();
  return res;
}

export async function deleteBakery(bakeryId) {
  if (staticPagesMode || adminSession.mode === 'github') {
    const target = (appState.bakeries || []).find((b) => b.id === bakeryId);
    appState.bakeries = (appState.bakeries || []).filter((b) => b.id !== bakeryId);
    appState.cakes = (appState.cakes || []).filter((c) => c.bakeryId !== bakeryId);
    await commitStateToGitHub(`🗑️ Remove confeitaria: ${target?.name || bakeryId}`);
    return;
  }

  await apiRequest(`/api/admin/bakeries/${encodeURIComponent(bakeryId)}`, {
    method: 'DELETE'
  });
  await refreshPublicData();
}

export async function saveCake(cakeData) {
  if (staticPagesMode || adminSession.mode === 'github') {
    const name = String(cakeData.name || '').trim();
    const bakeryId = String(cakeData.bakeryId || '').trim();
    if (!name || !bakeryId) throw new Error('Informe o nome do bolo e a confeitaria.');

    const bakery = (appState.bakeries || []).find((b) => b.id === bakeryId);
    const list = [...(appState.cakes || [])];
    const isEdit = Boolean(cakeData.id);
    const id = cakeData.id || `cake-${Date.now()}`;
    const existing = list.find((c) => c.id === id);
    const baseSlug = slugifyClient(`${name}-${bakery?.neighborhood || 'feira'}`);
    let slug = baseSlug;
    let c = 2;
    while (list.some((item) => item.slug === slug && item.id !== id)) {
      slug = `${baseSlug}-${c++}`;
    }

    const record = {
      id,
      bakeryId,
      slug,
      name,
      category: String(cakeData.category || 'Fatia de Vitrine'),
      flavorType: String(cakeData.flavorType || '').trim(),
      photos: Array.isArray(cakeData.photos) ? cakeData.photos.filter(Boolean) : [],
      scoreFlavor: Math.round(Number(cakeData.scoreFlavor || 0) * 2) / 2,
      scoreDough: Math.round(Number(cakeData.scoreDough || 0) * 2) / 2,
      scoreTexture: Math.round(Number(cakeData.scoreTexture || 0) * 2) / 2,
      scoreFilling: Math.round(Number(cakeData.scoreFilling || 0) * 2) / 2,
      kaiVerdict: String(cakeData.kaiVerdict || '').trim(),
      sensoryNotes: cakeData.sensoryNotes || {},
      approxPrice: Number(cakeData.approxPrice || 0),
      visitedAt: cakeData.visitedAt || new Date().toISOString().slice(0, 10),
      reevaluatedAt: cakeData.reevaluatedAt || null,
      reevaluationNote: String(cakeData.reevaluationNote || '').trim(),
      editionYear: Number(cakeData.editionYear || 2026),
      reactions: existing?.reactions || { waterInMouth: 0, agreeWithKai: 0, wantToTry: 0 }
    };

    const idx = list.findIndex((item) => item.id === id);
    if (idx >= 0) list[idx] = record;
    else list.push(record);

    appState.cakes = list;
    clearCakeDraft();
    await commitStateToGitHub(`🍰 ${isEdit ? 'Atualiza' : 'Publica'} avaliação: ${name}`);
    return { ok: true, id, slug };
  }

  const isEdit = Boolean(cakeData.id);
  const url = isEdit
    ? `/api/admin/cakes/${encodeURIComponent(cakeData.id)}`
    : '/api/admin/cakes';
  const method = isEdit ? 'PUT' : 'POST';

  const res = await apiRequest(url, {
    method,
    body: JSON.stringify(cakeData)
  });
  clearCakeDraft();
  await refreshPublicData();
  return res;
}

export async function deleteCake(cakeId) {
  if (staticPagesMode || adminSession.mode === 'github') {
    const target = (appState.cakes || []).find((c) => c.id === cakeId);
    appState.cakes = (appState.cakes || []).filter((c) => c.id !== cakeId);
    await commitStateToGitHub(`🗑️ Remove avaliação: ${target?.name || cakeId}`);
    return;
  }

  await apiRequest(`/api/admin/cakes/${encodeURIComponent(cakeId)}`, {
    method: 'DELETE'
  });
  await refreshPublicData();
}

export async function saveSettings(newSettings) {
  if (staticPagesMode || adminSession.mode === 'github') {
    appState.settings = {
      ...appState.settings,
      ...newSettings,
      weights: {
        ...(appState.settings?.weights || {}),
        ...(newSettings.weights || {})
      },
      kaiBio: {
        ...(appState.settings?.kaiBio || {}),
        ...(newSettings.kaiBio || {})
      }
    };
    await commitStateToGitHub('⚙️ Atualiza configurações e bio de Kai');
    return;
  }

  await apiRequest('/api/admin/settings', {
    method: 'PUT',
    body: JSON.stringify(newSettings)
  });
  await refreshPublicData();
}

export async function fetchAdminSuggestions() {
  if (staticPagesMode || adminSession.mode === 'github') {
    try {
      const localSugs = JSON.parse(localStorage.getItem(LOCAL_SUGGESTIONS_KEY) || '[]');
      return [...(appState.publicSuggestions || []), ...localSugs];
    } catch (_) {
      return appState.publicSuggestions || [];
    }
  }
  const json = await apiRequest('/api/admin/suggestions', { method: 'GET' });
  return json.suggestions || [];
}

export async function promoteSuggestionToUpcoming(sugId) {
  if (staticPagesMode || adminSession.mode === 'github') {
    const allSugs = await fetchAdminSuggestions();
    const sug = allSugs.find((s) => s.id === sugId);
    if (!sug) return;
    appState.upcomingBakeries = [
      ...(appState.upcomingBakeries || []),
      {
        id: `up-${Date.now()}`,
        name: sug.bakeryName,
        neighborhood: sug.neighborhood,
        specialty: sug.cakeSuggested,
        reason: sug.comment || `Sugerido por ${sug.submittedBy || 'Visitante'}`,
        votes: 1,
        plannedMonth: 'Em breve'
      }
    ];
    appState.publicSuggestions = (appState.publicSuggestions || []).filter((s) => s.id !== sugId);
    try {
      const localSugs = JSON.parse(localStorage.getItem(LOCAL_SUGGESTIONS_KEY) || '[]').filter(
        (s) => s.id !== sugId
      );
      localStorage.setItem(LOCAL_SUGGESTIONS_KEY, JSON.stringify(localSugs));
    } catch (_) {}
    await commitStateToGitHub(`🎈 Move sugestão para Em Breve: ${sug.bakeryName}`);
    return;
  }

  await apiRequest(`/api/admin/suggestions/${encodeURIComponent(sugId)}/promote`, {
    method: 'POST'
  });
  await refreshPublicData();
}

export async function deleteSuggestion(sugId) {
  if (staticPagesMode || adminSession.mode === 'github') {
    appState.publicSuggestions = (appState.publicSuggestions || []).filter((s) => s.id !== sugId);
    try {
      const localSugs = JSON.parse(localStorage.getItem(LOCAL_SUGGESTIONS_KEY) || '[]').filter(
        (s) => s.id !== sugId
      );
      localStorage.setItem(LOCAL_SUGGESTIONS_KEY, JSON.stringify(localSugs));
    } catch (_) {}
    return;
  }

  await apiRequest(`/api/admin/suggestions/${encodeURIComponent(sugId)}`, {
    method: 'DELETE'
  });
}

export async function addUpcomingBakery(data) {
  if (staticPagesMode || adminSession.mode === 'github') {
    appState.upcomingBakeries = [
      ...(appState.upcomingBakeries || []),
      {
        id: `up-${Date.now()}`,
        name: String(data.name || '').trim(),
        neighborhood: String(data.neighborhood || '').trim(),
        specialty: String(data.specialty || '').trim(),
        reason: String(data.reason || '').trim(),
        plannedMonth: String(data.plannedMonth || 'Em breve').trim(),
        votes: 1
      }
    ];
    await commitStateToGitHub(`🎈 Adiciona à fila Em Breve: ${data.name}`);
    return;
  }

  await apiRequest('/api/admin/upcoming', {
    method: 'POST',
    body: JSON.stringify(data)
  });
  await refreshPublicData();
}

export async function deleteUpcomingBakery(upId) {
  if (staticPagesMode || adminSession.mode === 'github') {
    appState.upcomingBakeries = (appState.upcomingBakeries || []).filter((u) => u.id !== upId);
    await commitStateToGitHub(`🗑️ Remove item da fila Em Breve`);
    return;
  }

  await apiRequest(`/api/admin/upcoming/${encodeURIComponent(upId)}`, {
    method: 'DELETE'
  });
  await refreshPublicData();
}

export async function downloadServerBackup() {
  if (staticPagesMode || adminSession.mode === 'github') {
    return appState;
  }
  const json = await apiRequest('/api/admin/backup', { method: 'GET' });
  return json.backup;
}

/* ==========================================================================
   AÇÕES PÚBLICAS ATÔMICAS COM PREVENÇÃO DE SPAM
   ========================================================================== */
export function hasVisitorReacted(cakeId, reactionKey) {
  try {
    const map = JSON.parse(localStorage.getItem(REACTED_STORAGE_KEY) || '{}');
    return Boolean(map[`${cakeId}:${reactionKey}`]);
  } catch (_) {
    return false;
  }
}

export async function reactToCake(cakeId, reactionKey) {
  if (hasVisitorReacted(cakeId, reactionKey)) {
    throw new Error('Você já registrou essa reação para este bolo!');
  }

  if (staticPagesMode) {
    try {
      const map = JSON.parse(localStorage.getItem(REACTED_STORAGE_KEY) || '{}');
      map[`${cakeId}:${reactionKey}`] = true;
      localStorage.setItem(REACTED_STORAGE_KEY, JSON.stringify(map));

      const counts = JSON.parse(localStorage.getItem(LOCAL_REACTION_COUNTS_KEY) || '{}');
      counts[`${cakeId}:${reactionKey}`] = Number(counts[`${cakeId}:${reactionKey}`] || 0) + 1;
      localStorage.setItem(LOCAL_REACTION_COUNTS_KEY, JSON.stringify(counts));
    } catch (_) {}
    await refreshPublicData();
    const cake = (appState.cakes || []).find((c) => c.id === cakeId);
    return cake?.reactions || {};
  }

  const json = await apiRequest(`/api/public/cakes/${encodeURIComponent(cakeId)}/react`, {
    method: 'POST',
    body: JSON.stringify({ reaction: reactionKey })
  });
  try {
    const map = JSON.parse(localStorage.getItem(REACTED_STORAGE_KEY) || '{}');
    map[`${cakeId}:${reactionKey}`] = true;
    localStorage.setItem(REACTED_STORAGE_KEY, JSON.stringify(map));
  } catch (_) {}
  await refreshPublicData();
  return json.reactions;
}

export function hasVisitorVoted(upId) {
  try {
    const map = JSON.parse(localStorage.getItem(VOTED_STORAGE_KEY) || '{}');
    return Boolean(map[upId]);
  } catch (_) {
    return false;
  }
}

export async function voteUpcomingBakery(upId) {
  if (hasVisitorVoted(upId)) {
    throw new Error('Seu voto para esta confeitaria já foi registrado!');
  }

  if (staticPagesMode) {
    try {
      const map = JSON.parse(localStorage.getItem(VOTED_STORAGE_KEY) || '{}');
      map[upId] = true;
      localStorage.setItem(VOTED_STORAGE_KEY, JSON.stringify(map));

      const counts = JSON.parse(localStorage.getItem(LOCAL_VOTE_COUNTS_KEY) || '{}');
      counts[upId] = Number(counts[upId] || 0) + 1;
      localStorage.setItem(LOCAL_VOTE_COUNTS_KEY, JSON.stringify(counts));
    } catch (_) {}
    await refreshPublicData();
    const up = (appState.upcomingBakeries || []).find((u) => u.id === upId);
    return up?.votes || 1;
  }

  const json = await apiRequest(`/api/public/upcoming/${encodeURIComponent(upId)}/vote`, {
    method: 'POST'
  });
  try {
    const map = JSON.parse(localStorage.getItem(VOTED_STORAGE_KEY) || '{}');
    map[upId] = true;
    localStorage.setItem(VOTED_STORAGE_KEY, JSON.stringify(map));
  } catch (_) {}
  await refreshPublicData();
  return json.votes;
}

export async function submitPublicSuggestion(sugData) {
  if (staticPagesMode) {
    try {
      const list = JSON.parse(localStorage.getItem(LOCAL_SUGGESTIONS_KEY) || '[]');
      list.unshift({
        id: `sug-${Date.now()}`,
        bakeryName: String(sugData.bakeryName || '').trim(),
        neighborhood: String(sugData.neighborhood || '').trim(),
        cakeSuggested: String(sugData.cakeSuggested || '').trim(),
        submittedBy: String(sugData.submittedBy || 'Visitante').trim(),
        comment: String(sugData.comment || '').trim(),
        createdAt: new Date().toISOString().slice(0, 10)
      });
      localStorage.setItem(LOCAL_SUGGESTIONS_KEY, JSON.stringify(list));
    } catch (_) {}
    return { ok: true };
  }

  return await apiRequest('/api/public/suggestions', {
    method: 'POST',
    body: JSON.stringify(sugData)
  });
}

/* ==========================================================================
   AUTOSAVE DE RASCUNHO NO PAINEL ADMIN & UPLOAD DE IMAGEM
   ========================================================================== */
export function saveCakeDraft(draftObj) {
  try {
    localStorage.setItem(ADMIN_DRAFT_CAKE_KEY, JSON.stringify(draftObj));
  } catch (_) {}
}

export function loadCakeDraft() {
  try {
    const raw = localStorage.getItem(ADMIN_DRAFT_CAKE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (_) {
    return null;
  }
}

export function clearCakeDraft() {
  try {
    localStorage.removeItem(ADMIN_DRAFT_CAKE_KEY);
  } catch (_) {}
}

export async function optimizeAndUploadImage(file) {
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const maxDim = 1100;
        let { width, height } = img;
        if (width > maxDim || height > maxDim) {
          if (width > height) {
            height = Math.round((height * maxDim) / width);
            width = maxDim;
          } else {
            width = Math.round((width * maxDim) / height);
            height = maxDim;
          }
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', 0.82));
      };
      img.onerror = () => reject(new Error('Não foi possível processar a imagem selecionada.'));
      img.src = reader.result;
    };
    reader.onerror = () => reject(new Error('Erro ao ler o arquivo de imagem.'));
    reader.readAsDataURL(file);
  });

  if (staticPagesMode || adminSession.mode === 'github') {
    if (!adminSession.authenticated || !adminSession.githubRepo) {
      throw new Error('Faça login com seu Token do GitHub para enviar imagens ao repositório.');
    }
    const b64Part = dataUrl.split(',')[1];
    const safeStem = slugifyClient((file.name || 'bolo').replace(/\.[^.]+$/, '')).slice(0, 28);
    const filename = `kai-${Date.now()}-${safeStem}.jpg`;
    await githubPutFile(
      adminSession.githubRepo,
      adminSession.githubBranch,
      `public/uploads/${filename}`,
      b64Part,
      `📸 Envia foto de avaliação: ${filename}`
    );
    return `/uploads/${filename}`;
  }

  const json = await apiRequest('/api/admin/upload', {
    method: 'POST',
    body: JSON.stringify({
      filename: file.name || 'bolo.jpg',
      dataUrl
    })
  });
  return json.url;
}
