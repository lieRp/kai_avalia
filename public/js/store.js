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
const UPLOAD_PREVIEW_STORAGE_KEY = 'sugarcube_upload_previews_v1';

const UPLOAD_PREVIEW_CACHE = new Map();

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

function normalizeUploadKey(pathStr) {
  if (!pathStr || typeof pathStr !== 'string') return '';
  const idx = pathStr.indexOf('/uploads/');
  if (idx >= 0) return pathStr.slice(idx).split('?')[0];
  return pathStr.trim();
}

export function cacheUploadedPreview(pathStr, dataUrl) {
  const key = normalizeUploadKey(pathStr);
  if (!key || !dataUrl) return;
  UPLOAD_PREVIEW_CACHE.set(key, dataUrl);
  try {
    const raw = JSON.parse(sessionStorage.getItem(UPLOAD_PREVIEW_STORAGE_KEY) || '{}');
    raw[key] = dataUrl;
    const keys = Object.keys(raw);
    while (keys.length > 6) {
      delete raw[keys.shift()];
    }
    sessionStorage.setItem(UPLOAD_PREVIEW_STORAGE_KEY, JSON.stringify(raw));
  } catch (_) {}
}

export function getCachedUploadPreview(pathStr) {
  const key = normalizeUploadKey(pathStr);
  if (!key) return null;
  if (UPLOAD_PREVIEW_CACHE.has(key)) {
    return UPLOAD_PREVIEW_CACHE.get(key);
  }
  try {
    const raw = JSON.parse(sessionStorage.getItem(UPLOAD_PREVIEW_STORAGE_KEY) || '{}');
    if (raw[key]) {
      UPLOAD_PREVIEW_CACHE.set(key, raw[key]);
      return raw[key];
    }
  } catch (_) {}
  return null;
}

let staticPagesMode =
  typeof window !== 'undefined' &&
  (window.location.hostname.endsWith('.github.io') ||
    window.location.hostname.endsWith('kaiavalia.com.br'));

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

export function getRawGitHubUploadUrl(pathStr) {
  if (!pathStr || typeof pathStr !== 'string') return '';
  const idx = pathStr.indexOf('/uploads/');
  if (idx < 0) return '';
  const filename = pathStr.slice(idx + '/uploads/'.length).split('?')[0];
  if (!filename) return '';
  const repo = adminSession.githubRepo || detectDefaultGitHubRepo() || 'lieRp/kai_avalia';
  const branch = adminSession.githubBranch || 'main';
  return `https://raw.githubusercontent.com/${repo}/${branch}/public/uploads/${filename}`;
}

export function resolveDisplayImageUrl(pathStr, fallback = '/assets/og-sugarcube.svg') {
  const clean = String(pathStr || '').trim();
  if (!clean) {
    return fallback ? resolveSitePath(fallback) : '';
  }
  const cached = getCachedUploadPreview(clean);
  if (cached) {
    return cached;
  }
  return resolveSitePath(clean);
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
  const method = (options.method || 'GET').toUpperCase();
  const headers = {
    Accept: 'application/vnd.github+json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(options.headers || {})
  };
  let finalEndpoint = endpoint;
  if (method === 'GET') {
    const sep = finalEndpoint.includes('?') ? '&' : '?';
    finalEndpoint = `${finalEndpoint}${sep}_t=${Date.now()}`;
  }
  const res = await fetch(`https://api.github.com${finalEndpoint}`, {
    cache: 'no-store',
    ...options,
    headers
  });
  let data = {};
  try {
    data = await res.json();
  } catch (_) {}
  if (!res.ok) {
    const err = new Error(data.message || `Erro na API do GitHub (HTTP ${res.status}).`);
    err.status = res.status;
    throw err;
  }
  return data;
}

async function githubPutFile(repo, branch, filePath, contentB64, commitMessage, retryCount = 0) {
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

  try {
    return await githubApiRequest(`/repos/${repo}/contents/${filePath}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
  } catch (err) {
    if ((err.status === 409 || String(err.message).includes('does not match')) && retryCount < 2) {
      await new Promise((r) => setTimeout(r, 450));
      return await githubPutFile(repo, branch, filePath, contentB64, commitMessage, retryCount + 1);
    }
    throw err;
  }
}

async function syncLatestStateFromGitHub() {
  if (!adminSession.authenticated || adminSession.mode !== 'github' || !adminSession.githubRepo) {
    return;
  }
  try {
    const fileObj = await githubApiRequest(
      `/repos/${adminSession.githubRepo}/contents/public/data/public.json?ref=${encodeURIComponent(
        adminSession.githubBranch
      )}`
    );
    if (fileObj && fileObj.content) {
      const parsed = JSON.parse(decodeBase64Utf8(fileObj.content));
      if (parsed && Array.isArray(parsed.bakeries) && Array.isArray(parsed.cakes)) {
        appState = applyLocalVisitorOverlays(parsed);
      }
    }
  } catch (_) {}
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
  const repo = adminSession.githubRepo;
  const branch = adminSession.githubBranch;

  // Tenta realizar commit único e atômico nos 3 arquivos de estado (seed, public e docs)
  try {
    const refData = await githubApiRequest(
      `/repos/${repo}/git/ref/heads/${encodeURIComponent(branch)}`
    );
    const latestCommitSha = refData?.object?.sha;
    if (latestCommitSha) {
      const commitData = await githubApiRequest(
        `/repos/${repo}/git/commits/${latestCommitSha}`
      );
      const baseTreeSha = commitData?.tree?.sha;
      if (baseTreeSha) {
        const treeRes = await githubApiRequest(`/repos/${repo}/git/trees`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            base_tree: baseTreeSha,
            tree: [
              { path: 'data/seed.json', mode: '100644', type: 'blob', content: jsonStr },
              { path: 'public/data/public.json', mode: '100644', type: 'blob', content: jsonStr },
              { path: 'docs/data/public.json', mode: '100644', type: 'blob', content: jsonStr }
            ]
          })
        });
        if (treeRes?.sha) {
          const newCommit = await githubApiRequest(`/repos/${repo}/git/commits`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              message: commitMessage,
              tree: treeRes.sha,
              parents: [latestCommitSha]
            })
          });
          if (newCommit?.sha) {
            await githubApiRequest(
              `/repos/${repo}/git/refs/heads/${encodeURIComponent(branch)}`,
              {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ sha: newCommit.sha })
              }
            );
            return;
          }
        }
      }
    }
  } catch (_) {
    // Fallback para Contents API caso o token não permita Git Data API
  }

  const b64 = encodeBase64Utf8(jsonStr);
  await githubPutFile(repo, branch, 'data/seed.json', b64, commitMessage);
  await githubPutFile(
    repo,
    branch,
    'public/data/public.json',
    b64,
    `${commitMessage} (sync public)`
  );
  try {
    await githubPutFile(
      repo,
      branch,
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
  const isGithubDomain =
    window.location.hostname.endsWith('.github.io') ||
    window.location.hostname.endsWith('kaiavalia.com.br');

  if (!staticPagesMode && !isGithubDomain) {
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
  } else {
    staticPagesMode = true;
  }

  // Verificar se há sessão GitHub salva no localStorage ou sessionStorage do navegador
  try {
    const rawSession =
      localStorage.getItem(GH_SESSION_STORAGE_KEY) ||
      sessionStorage.getItem(GH_SESSION_STORAGE_KEY) ||
      'null';
    const saved = JSON.parse(rawSession);
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
  await checkAdminSession();
  await refreshPublicData();
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
  let cleanRepo = String(repoFullName || '')
    .trim()
    .replace(/^https?:\/\/github\.com\//i, '')
    .replace(/\.git$/i, '')
    .replace(/^\/+|\/+$/g, '');
  const cleanToken = String(token || '').trim();

  if (!cleanRepo || cleanRepo.toLowerCase() === 'kai' || cleanRepo.toLowerCase() === 'lierp') {
    cleanRepo = 'lieRp/kai_avalia';
  } else if (!cleanRepo.includes('/')) {
    cleanRepo = `lieRp/${cleanRepo}`;
  }

  if (!cleanToken) {
    throw new Error('Informe a sua senha de acesso.');
  }

  let repoInfo;
  try {
    repoInfo = await githubApiRequest(`/repos/${cleanRepo}`, { token: cleanToken });
  } catch (err) {
    throw new Error('Usuário ou senha incorretos. Verifique suas credenciais de acesso.');
  }

  if (repoInfo.permissions && !repoInfo.permissions.push) {
    throw new Error('Esta senha não possui permissão de publicação neste guia.');
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
    const serialized = JSON.stringify(adminSession);
    localStorage.setItem(GH_SESSION_STORAGE_KEY, serialized);
    sessionStorage.setItem(GH_SESSION_STORAGE_KEY, serialized);
  } catch (_) {}

  await refreshPublicData();
  return true;
}

export async function logoutAdmin() {
  if (adminSession.mode === 'github' || staticPagesMode) {
    try {
      localStorage.removeItem(GH_SESSION_STORAGE_KEY);
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
   COORDENADAS REAIS DOS BAIRROS DE FEIRA DE SANTANA - BA & GEOCODING
   ========================================================================== */
export const FSA_NEIGHBORHOOD_COORDS = {
  'santa monica': [-12.2502, -38.9395],
  'kalilandia': [-12.2518, -38.9612],
  'capuchinhos': [-12.2558, -38.9482],
  'ponto central': [-12.2508, -38.9502],
  'centro': [-12.2552, -38.9635],
  'sao joao': [-12.2455, -38.9695],
  'sim': [-12.2435, -38.9205],
  'noide': [-12.2485, -38.9262],
  'noide cerqueira': [-12.2485, -38.9262],
  'muchila': [-12.2412, -38.9668],
  'fraga maia': [-12.2265, -38.9560],
  'cidade nova': [-12.2315, -38.9612],
  'caseb': [-12.2405, -38.9500],
  'brasilia': [-12.2645, -38.9515],
  'getulio vargas': [-12.2558, -38.9535],
  'tomba': [-12.2880, -38.9625],
  'sobradinho': [-12.2380, -38.9710],
  'mangabeira': [-12.2195, -38.9640],
  'parque ipe': [-12.2345, -38.9780],
  'papagaio': [-12.2150, -38.9480],
  'queimadinha': [-12.2620, -38.9705],
  'santo antonio dos prazeres': [-12.2350, -38.9180],
  'conceicao': [-12.2280, -38.9410],
  'jardim cruzeiro': [-12.2440, -38.9615]
};

export function resolveFsaCoordinates(neighborhood = '', seedText = '') {
  const norm = slugifyClient(neighborhood).replace(/-/g, ' ');
  let base = [-12.2535, -38.9545];
  for (const [k, coords] of Object.entries(FSA_NEIGHBORHOOD_COORDS)) {
    if (norm.includes(k) || k.includes(norm)) {
      base = coords;
      break;
    }
  }
  const hashSource = `${neighborhood}|${seedText}`;
  let h = 0;
  for (let i = 0; i < hashSource.length; i++) {
    h = (h * 31 + hashSource.charCodeAt(i)) % 10000;
  }
  const latOffset = ((h % 100) - 50) * 0.00007;
  const lngOffset = ((Math.floor(h / 100) % 100) - 50) * 0.00007;
  return {
    lat: Number((base[0] + latOffset).toFixed(5)),
    lng: Number((base[1] + lngOffset).toFixed(5))
  };
}

export async function geocodeFsaLocation(name = '', address = '', neighborhood = '') {
  const queries = [
    address && `${address}, ${neighborhood}, Feira de Santana, Bahia, Brasil`,
    name && neighborhood && `${name}, ${neighborhood}, Feira de Santana, Bahia, Brasil`,
    neighborhood && `${neighborhood}, Feira de Santana, Bahia, Brasil`
  ].filter(Boolean);

  for (const q of queries) {
    try {
      const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(
        q
      )}`;
      const res = await fetch(url, {
        headers: { 'Accept-Language': 'pt-BR' }
      });
      if (res.ok) {
        const items = await res.json();
        if (Array.isArray(items) && items.length > 0) {
          const lat = Number(items[0].lat);
          const lng = Number(items[0].lon);
          if (lat < -12.1 && lat > -12.4 && lng < -38.8 && lng > -39.1) {
            return { lat: Number(lat.toFixed(5)), lng: Number(lng.toFixed(5)), source: 'osm' };
          }
        }
      }
    } catch (_) {}
  }

  return { ...resolveFsaCoordinates(neighborhood, `${name}-${address}`), source: 'neighborhood' };
}

/* ==========================================================================
   OPERAÇÕES ADMIN PROTEGIDAS (CONFEITARIAS, BOLOS, CONFIGURAÇÕES)
   ========================================================================== */
export async function saveBakery(bakeryData) {
  let latVal = Number(bakeryData.lat);
  let lngVal = Number(bakeryData.lng);
  const isDefaultCoords =
    !latVal ||
    !lngVal ||
    (Math.abs(latVal - -12.2545) < 0.0002 && Math.abs(lngVal - -38.955) < 0.0002);
  if (isDefaultCoords) {
    const resolved = resolveFsaCoordinates(
      bakeryData.neighborhood,
      `${bakeryData.name}-${bakeryData.address}`
    );
    latVal = resolved.lat;
    lngVal = resolved.lng;
  }

  if (staticPagesMode || adminSession.mode === 'github') {
    await syncLatestStateFromGitHub();
    const name = String(bakeryData.name || '').trim();
    const neighborhood = String(bakeryData.neighborhood || '').trim();
    if (!name || !neighborhood) throw new Error('Informe nome e bairro da confeitaria.');

    const list = [...(appState.bakeries || [])];
    const isEdit = Boolean(bakeryData.id);
    const id = bakeryData.id || `bak-${Date.now()}`;
    const existing = list.find((b) => b.id === id);
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
      address: String(bakeryData.address || `Bairro ${neighborhood}, Feira de Santana - BA`).trim(),
      lat: latVal,
      lng: lngVal,
      instagram: String(bakeryData.instagram || '').trim(),
      whatsapp: String(bakeryData.whatsapp || '').trim(),
      openingHours: String(bakeryData.openingHours || '').trim(),
      priceRange: String(bakeryData.priceRange || '$$'),
      coverPhoto: String(bakeryData.coverPhoto || '').trim(),
      description: String(bakeryData.description || '').trim(),
      isFeaturedPartner: Boolean(bakeryData.isFeaturedPartner),
      createdAt: bakeryData.createdAt || existing?.createdAt || new Date().toISOString().slice(0, 10)
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
    body: JSON.stringify({ ...bakeryData, lat: latVal, lng: lngVal })
  });
  await refreshPublicData();
  return res;
}

export async function deleteBakery(bakeryId) {
  if (staticPagesMode || adminSession.mode === 'github') {
    await syncLatestStateFromGitHub();
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
    await syncLatestStateFromGitHub();
    const name = String(cakeData.name || '').trim();
    let bakeryId = String(cakeData.bakeryId || '').trim();

    if (bakeryId === '__new__' && cakeData.newBakery) {
      const nbName = String(cakeData.newBakery.name || '').trim();
      const nbNeigh = String(cakeData.newBakery.neighborhood || '').trim();
      if (!nbName || !nbNeigh) {
        throw new Error('Informe o nome e o bairro da nova confeitaria.');
      }
      const existingBak = (appState.bakeries || []).find(
        (b) =>
          b.name.toLowerCase() === nbName.toLowerCase() &&
          b.neighborhood.toLowerCase() === nbNeigh.toLowerCase()
      );
      if (existingBak) {
        bakeryId = existingBak.id;
      } else {
        const coords = resolveFsaCoordinates(nbNeigh, nbName);
        const newBakId = `bak-${Date.now()}`;
        const baseBakSlug = slugifyClient(`${nbName}-${nbNeigh}`);
        let bakSlug = baseBakSlug;
        let bc = 2;
        while ((appState.bakeries || []).some((b) => b.slug === bakSlug)) {
          bakSlug = `${baseBakSlug}-${bc++}`;
        }
        const newBakRecord = {
          id: newBakId,
          slug: bakSlug,
          name: nbName,
          neighborhood: nbNeigh,
          address:
            String(cakeData.newBakery.address || '').trim() ||
            `Bairro ${nbNeigh}, Feira de Santana - BA`,
          lat: coords.lat,
          lng: coords.lng,
          instagram: '',
          whatsapp: '',
          openingHours: '',
          priceRange: String(cakeData.newBakery.priceRange || '$$'),
          coverPhoto: '',
          description: `Confeitaria avaliada por Kai Tavares no bairro ${nbNeigh}.`,
          isFeaturedPartner: false,
          createdAt: new Date().toISOString().slice(0, 10)
        };
        appState.bakeries = [...(appState.bakeries || []), newBakRecord];
        bakeryId = newBakId;
      }
    }

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

  let targetBakeryId = cakeData.bakeryId;
  if (targetBakeryId === '__new__' && cakeData.newBakery) {
    const nbName = String(cakeData.newBakery.name || '').trim();
    const nbNeigh = String(cakeData.newBakery.neighborhood || '').trim();
    if (!nbName || !nbNeigh) {
      throw new Error('Informe o nome e o bairro da nova confeitaria.');
    }
    const existingBak = (appState?.bakeries || []).find(
      (b) =>
        b.name.toLowerCase() === nbName.toLowerCase() &&
        b.neighborhood.toLowerCase() === nbNeigh.toLowerCase()
    );
    if (existingBak) {
      targetBakeryId = existingBak.id;
    } else {
      const createdBak = await saveBakery({
        name: nbName,
        neighborhood: nbNeigh,
        address:
          String(cakeData.newBakery.address || '').trim() ||
          `Bairro ${nbNeigh}, Feira de Santana - BA`,
        priceRange: String(cakeData.newBakery.priceRange || '$$'),
        description: `Confeitaria avaliada por Kai Tavares no bairro ${nbNeigh}.`
      });
      targetBakeryId = createdBak.id;
    }
  }

  const isEdit = Boolean(cakeData.id);
  const url = isEdit
    ? `/api/admin/cakes/${encodeURIComponent(cakeData.id)}`
    : '/api/admin/cakes';
  const method = isEdit ? 'PUT' : 'POST';

  const res = await apiRequest(url, {
    method,
    body: JSON.stringify({ ...cakeData, bakeryId: targetBakeryId })
  });
  clearCakeDraft();
  await refreshPublicData();
  return res;
}

export async function deleteCake(cakeId) {
  if (staticPagesMode || adminSession.mode === 'github') {
    await syncLatestStateFromGitHub();
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
    await syncLatestStateFromGitHub();
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
    await syncLatestStateFromGitHub();
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
    await syncLatestStateFromGitHub();
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
    await syncLatestStateFromGitHub();
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
  if (!file) {
    throw new Error('Selecione um arquivo de imagem válido.');
  }
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
        ctx.fillStyle = '#FFFFFF';
        ctx.fillRect(0, 0, width, height);
        ctx.drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', 0.84));
      };
      img.onerror = () =>
        reject(
          new Error(
            'Formato de imagem não suportado pelo navegador. Use fotos em JPG, PNG ou WebP.'
          )
        );
      img.src = reader.result;
    };
    reader.onerror = () => reject(new Error('Erro ao ler o arquivo de imagem.'));
    reader.readAsDataURL(file);
  });

  if (staticPagesMode || adminSession.mode === 'github') {
    if (!adminSession.authenticated || !adminSession.githubRepo) {
      throw new Error('Faça login no painel para enviar imagens ao guia.');
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
    const uploadedPath = `/uploads/${filename}`;
    cacheUploadedPreview(uploadedPath, dataUrl);
    return uploadedPath;
  }

  const json = await apiRequest('/api/admin/upload', {
    method: 'POST',
    body: JSON.stringify({
      filename: file.name || 'bolo.jpg',
      dataUrl
    })
  });
  cacheUploadedPreview(json.url, dataUrl);
  return json.url;
}

export async function rotateAndUploadImage(currentUrl) {
  const cleanUrl = String(currentUrl || '').trim();
  if (!cleanUrl) {
    throw new Error('Nenhuma foto selecionada para girar.');
  }

  const loadForRotation = (src) =>
    new Promise((resolve, reject) => {
      if (!src) return reject(new Error('URL vazia'));
      const img = new Image();
      if (!src.startsWith('data:')) {
        img.crossOrigin = 'anonymous';
      }
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Falha ao carregar imagem para rotação.'));
      img.src = src;
    });

  let img = null;
  const candidates = [
    getCachedUploadPreview(cleanUrl),
    resolveSitePath(cleanUrl),
    getRawGitHubUploadUrl(cleanUrl)
  ].filter(Boolean);

  for (const src of candidates) {
    try {
      img = await loadForRotation(src);
      if (img) break;
    } catch (_) {}
  }

  if (!img) {
    throw new Error('Não foi possível carregar a foto atual para girar.');
  }

  const canvas = document.createElement('canvas');
  canvas.width = img.height;
  canvas.height = img.width;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate(Math.PI / 2);
  ctx.drawImage(img, -img.width / 2, -img.height / 2);
  const rotatedDataUrl = canvas.toDataURL('image/jpeg', 0.86);

  if (staticPagesMode || adminSession.mode === 'github') {
    if (!adminSession.authenticated || !adminSession.githubRepo) {
      throw new Error('Faça login no painel para salvar a foto girada.');
    }
    const b64Part = rotatedDataUrl.split(',')[1];
    const filename = `kai-${Date.now()}-rot.jpg`;
    await githubPutFile(
      adminSession.githubRepo,
      adminSession.githubBranch,
      `public/uploads/${filename}`,
      b64Part,
      `📸 Gira foto de avaliação: ${filename}`
    );
    const uploadedPath = `/uploads/${filename}`;
    cacheUploadedPreview(uploadedPath, rotatedDataUrl);
    return uploadedPath;
  }

  const json = await apiRequest('/api/admin/upload', {
    method: 'POST',
    body: JSON.stringify({
      filename: 'foto-girada.jpg',
      dataUrl: rotatedDataUrl
    })
  });
  cacheUploadedPreview(json.url, rotatedDataUrl);
  return json.url;
}
