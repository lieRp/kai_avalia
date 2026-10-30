/**
 * Sugarcube Corner • por Kai Tavares (Feira de Santana - BA)
 * Aplicação Principal:
 * - Roteamento real via History API (/ranking, /confeitaria/:slug, /bolo/:slug, /mapa, /em-breve, /sobre, /admin)
 * - Linguagem 100% sem pronomes para Kai + estética Sugarcube Corner (My Little Pony)
 * - Tratamento explícito de erros, confirmação antes de excluir, autosave de rascunho e preview de Story no Admin
 * - Acessibilidade com aria-hidden em emojis decorativos e alt descritivos em todas as imagens
 */

import {
  initStore,
  getState,
  getEnrichedCakes,
  getEnrichedBakeries,
  computeCakeFinalScore,
  isCakeApprovedByKai,
  isAdminLoggedIn,
  isStaticPagesMode,
  getAdminSessionInfo,
  detectDefaultGitHubRepo,
  SITE_BASE_PATH,
  resolveSitePath,
  loginAdmin,
  loginAdminWithGitHub,
  logoutAdmin,
  changeAdminPassword,
  saveBakery,
  deleteBakery,
  saveCake,
  deleteCake,
  saveSettings,
  fetchAdminSuggestions,
  reactToCake,
  hasVisitorReacted,
  voteUpcomingBakery,
  hasVisitorVoted,
  addUpcomingBakery,
  deleteUpcomingBakery,
  submitPublicSuggestion,
  promoteSuggestionToUpcoming,
  deleteSuggestion,
  downloadServerBackup,
  saveCakeDraft,
  loadCakeDraft,
  clearCakeDraft,
  optimizeAndUploadImage
} from './store.js';

import { renderRadarChartSVG, renderCriteriaBarsHTML } from './charts.js';
import { renderStoryCardToCanvas } from './storyGenerator.js';

const mainEl = document.getElementById('app-main');

const uiState = {
  homeCriterion: 'finalScore',
  rankingTab: 'cakes',
  rankingSearch: '',
  rankingNeighborhood: 'all',
  rankingCategory: 'all',
  rankingPrice: 'all',
  rankingYear: 'all',
  rankingSort: 'finalScore',
  rankingOnlyApproved: false,
  visitorCustomWeights: null,
  showWeightSimulator: false,
  mapNeighborhood: 'all',
  adminTab: 'cakes',
  editingCakeId: null,
  editingBakeryId: null,
  adminSuggestions: []
};

let activeLeafletMap = null;
let currentStoryCake = null;

/* ==========================================================================
   UTILITÁRIOS DE UI, TOAST DE ERRO/SUCESSO & NAVEGAÇÃO HISTORY API
   ========================================================================== */
export function showToast(message, isError = false) {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const el = document.createElement('div');
  el.className = `toast-item ${isError ? 'toast-error' : ''}`;
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 250);
  }, 4000);
}

function escapeHTML(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatBRL(val) {
  return Number(val || 0).toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL'
  });
}

function formatDateBR(isoDate) {
  if (!isoDate) return '';
  const parts = String(isoDate).split('-');
  if (parts.length !== 3) return isoDate;
  return `${parts[2]}/${parts[1]}/${parts[0]}`;
}

export function navigateTo(url, replace = false) {
  const targetUrl = resolveSitePath(url);
  if (replace) {
    window.history.replaceState({}, '', targetUrl);
  } else {
    window.history.pushState({}, '', targetUrl);
  }
  handleRouteChange();
}

function applySubpathFixes(root = document.body) {
  if (!SITE_BASE_PATH || !root) return;
  root.querySelectorAll('img[src^="/"]').forEach((img) => {
    const raw = img.getAttribute('src');
    const fixed = resolveSitePath(raw);
    if (fixed !== raw) img.setAttribute('src', fixed);
  });
  root.querySelectorAll('image[href^="/"]').forEach((svgImg) => {
    const raw = svgImg.getAttribute('href');
    const fixed = resolveSitePath(raw);
    if (fixed !== raw) svgImg.setAttribute('href', fixed);
  });
  root.querySelectorAll('a[href^="/"]').forEach((a) => {
    const raw = a.getAttribute('href');
    const fixed = resolveSitePath(raw);
    if (fixed !== raw) a.setAttribute('href', fixed);
  });
}

function updateSEOMeta({ title, description, image, jsonLd }) {
  document.title = title
    ? `${title} | Sugarcube Corner • Kai Tavares`
    : 'Sugarcube Corner — O Ranking de Bolos de Feira de Santana por Kai Tavares';

  const canonicalUrl = window.location.origin + window.location.pathname;
  document.getElementById('canonical-link')?.setAttribute('href', canonicalUrl);
  document.getElementById('og-url')?.setAttribute('content', canonicalUrl);
  document.getElementById('og-title')?.setAttribute('content', document.title);
  document.getElementById('twitter-title')?.setAttribute('content', document.title);

  if (description) {
    document.getElementById('meta-description')?.setAttribute('content', description);
    document.getElementById('og-description')?.setAttribute('content', description);
    document.getElementById('twitter-description')?.setAttribute('content', description);
  }
  if (image) {
    const absImg = image.startsWith('http') ? image : window.location.origin + image;
    document.getElementById('og-image')?.setAttribute('content', absImg);
    document.getElementById('twitter-image')?.setAttribute('content', absImg);
  }
  const schemaEl = document.getElementById('schema-jsonld');
  if (schemaEl && jsonLd) {
    schemaEl.textContent = JSON.stringify(jsonLd, null, 2);
  }
}

function updateHeaderAdminStatus() {
  const dot = document.getElementById('admin-status-dot');
  const label = document.getElementById('admin-btn-label');
  if (!dot || !label) return;
  if (isAdminLoggedIn()) {
    dot.classList.add('logged-in');
    label.textContent = 'Painel de Kai (Ativo)';
  } else {
    dot.classList.remove('logged-in');
    label.textContent = 'Área de Kai';
  }
}

function renderHeroPonyWatermarkSVG() {
  return `
    <div class="hero-pony-watermark" aria-hidden="true">
      <img src="/assets/mlp-cloud-wave-2.png" alt="" class="hero-wm-cloud" />
      <img src="/assets/mlp-butterflies.png" alt="" class="hero-wm-butterflies" />
    </div>
  `;
}

/* ==========================================================================
   MODAL DO GERADOR DE CARD 9:16 (STORIES)
   ========================================================================== */
async function openStoryModalWithCakeObject(cakeObj) {
  if (!cakeObj) return;
  currentStoryCake = cakeObj;
  const modal = document.getElementById('story-modal');
  const canvas = document.getElementById('story-canvas');
  if (!modal || !canvas) return;

  modal.hidden = false;
  modal.setAttribute('aria-hidden', 'false');
  await renderStoryCardToCanvas(canvas, cakeObj);
}

async function openStoryModal(cakeId) {
  const cakes = getEnrichedCakes(uiState.visitorCustomWeights);
  const cake = cakes.find((c) => c.id === cakeId || c.slug === cakeId);
  if (!cake) return;
  await openStoryModalWithCakeObject(cake);
}

function setupStoryModalEvents() {
  const modal = document.getElementById('story-modal');
  const closeBtn = document.getElementById('close-story-modal');
  const downloadBtn = document.getElementById('download-story-btn');
  const shareBtn = document.getElementById('share-story-native-btn');
  const canvas = document.getElementById('story-canvas');

  if (closeBtn && modal) {
    closeBtn.addEventListener('click', () => {
      modal.hidden = true;
      modal.setAttribute('aria-hidden', 'true');
    });
    modal.addEventListener('click', (e) => {
      if (e.target === modal) {
        modal.hidden = true;
        modal.setAttribute('aria-hidden', 'true');
      }
    });
  }

  if (downloadBtn && canvas) {
    downloadBtn.addEventListener('click', () => {
      const link = document.createElement('a');
      const slug = currentStoryCake?.slug || 'avaliacao-kai';
      link.download = `story-sugarcube-${slug}.png`;
      link.href = canvas.toDataURL('image/png');
      link.click();
      showToast('Card 9:16 da Sugarcube Corner baixado!');
    });
  }

  if (shareBtn && canvas) {
    shareBtn.addEventListener('click', async () => {
      try {
        const blob = await new Promise((res) => canvas.toBlob(res, 'image/png'));
        const file = new File([blob], `sugarcube-${currentStoryCake?.slug || 'story'}.png`, {
          type: 'image/png'
        });
        if (navigator.canShare && navigator.canShare({ files: [file] })) {
          await navigator.share({
            title: `Avaliação de Kai: ${currentStoryCake?.name}`,
            text: `Olha a nota desse bolo em Feira de Santana no Sugarcube Corner por Kai Tavares!`,
            files: [file]
          });
          return;
        }
      } catch (_) {}
      downloadBtn.click();
    });
  }
}

/* ==========================================================================
   COMPONENTE DE CARD DE BOLO REUTILIZÁVEL
   ========================================================================== */
function renderCakeCardHTML(cake, rankIndex = null, highlightCrit = 'finalScore') {
  const medalClass =
    rankIndex === 0 ? 'medal-1' : rankIndex === 1 ? 'medal-2' : rankIndex === 2 ? 'medal-3' : '';
  const cardRankClass = rankIndex === 0 ? 'rank-1' : '';

  const mainDisplayScore =
    highlightCrit && highlightCrit !== 'finalScore' && cake[highlightCrit] !== undefined
      ? Number(cake[highlightCrit]).toFixed(1)
      : Number(cake.finalScore).toFixed(1);

  const mainDisplayLabel =
    highlightCrit === 'scoreTexture'
      ? 'Textura'
      : highlightCrit === 'scoreDough'
      ? 'Massa'
      : highlightCrit === 'scoreFlavor'
      ? 'Sabor'
      : highlightCrit === 'scoreFilling'
      ? 'Recheio'
      : 'Nota Final';

  return `
    <article class="cake-card ${cardRankClass}">
      <div class="card-media">
        ${
          rankIndex !== null
            ? `<span class="rank-medal ${medalClass}">#${rankIndex + 1}</span>`
            : ''
        }
        <a href="/bolo/${encodeURIComponent(cake.slug)}">
          <img src="${escapeHTML(cake.photos?.[0] || '/assets/og-sugarcube.svg')}" alt="Foto de ${escapeHTML(cake.name)} na confeitaria ${escapeHTML(cake.bakery?.name)}" loading="lazy" />
        </a>
        <div class="score-badge-floating">
          <span class="score-num">${mainDisplayScore}</span>
          <span class="score-lbl">${mainDisplayLabel}</span>
        </div>
      </div>

      <div class="card-body">
        <div class="card-meta-top">
          <span class="neighborhood-tag"><span aria-hidden="true">📍</span> ${escapeHTML(cake.bakery?.neighborhood)}</span>
          ${
            cake.kaiApproved
              ? `<span class="kai-seal" title="Nota alta e textura impecável aprovada por Kai"><span aria-hidden="true">🎈</span> Aprovado por Kai</span>`
              : `<span style="font-size:0.75rem;color:var(--text-muted);">${escapeHTML(cake.category)}</span>`
          }
        </div>

        <h3 class="card-title">
          <a href="/bolo/${encodeURIComponent(cake.slug)}">${escapeHTML(cake.name)}</a>
        </h3>

        <a href="/confeitaria/${encodeURIComponent(cake.bakery?.slug)}" class="card-bakery-link">
          <span aria-hidden="true">🧁</span> ${escapeHTML(cake.bakery?.name)} (${escapeHTML(cake.bakery?.priceRange || '$$')})
        </a>

        <p class="card-quote">"${escapeHTML(cake.kaiVerdict)}"</p>

        <div class="mini-criteria-grid">
          <div class="mini-crit-box ${highlightCrit === 'scoreTexture' ? 'highlight-crit' : ''}">
            <span class="mini-crit-label">Textura</span>
            <span class="mini-crit-val">${Number(cake.scoreTexture).toFixed(1)}</span>
          </div>
          <div class="mini-crit-box ${highlightCrit === 'scoreDough' ? 'highlight-crit' : ''}">
            <span class="mini-crit-label">Massa</span>
            <span class="mini-crit-val">${Number(cake.scoreDough).toFixed(1)}</span>
          </div>
          <div class="mini-crit-box ${highlightCrit === 'scoreFlavor' ? 'highlight-crit' : ''}">
            <span class="mini-crit-label">Sabor</span>
            <span class="mini-crit-val">${Number(cake.scoreFlavor).toFixed(1)}</span>
          </div>
          <div class="mini-crit-box ${highlightCrit === 'scoreFilling' ? 'highlight-crit' : ''}">
            <span class="mini-crit-label">Recheio</span>
            <span class="mini-crit-val">${Number(cake.scoreFilling).toFixed(1)}</span>
          </div>
        </div>

        <div style="display:flex;justify-content:space-between;align-items:center;font-size:0.75rem;color:var(--text-muted);padding-top:0.25rem;">
          <span>Visita: ${formatDateBR(cake.latestVisit)}</span>
          ${cake.isStale ? `<span class="stale-review-badge" title="Avaliação com mais de 6 meses"><span aria-hidden="true">⏳</span> +6 meses</span>` : ''}
        </div>

        <div class="card-footer">
          <span class="price-tag">${formatBRL(cake.approxPrice)}</span>
          <div style="display:flex;gap:0.4rem;align-items:center;">
            <button type="button" class="btn btn-secondary btn-sm js-open-story" data-cake-id="${escapeHTML(cake.id)}" title="Gerar Card 9:16 para Stories">
              <span aria-hidden="true">📲</span> Story
            </button>
            <a href="/bolo/${encodeURIComponent(cake.slug)}" class="btn btn-primary btn-sm">
              Ler análise →
            </a>
          </div>
        </div>
      </div>
    </article>
  `;
}

/* ==========================================================================
   1. PÁGINA HOME (/)
   ========================================================================== */
function renderHomeView() {
  const state = getState();
  const cakes = getEnrichedCakes();
  const bakeries = getEnrichedBakeries().sort((a, b) => b.rankingScore - a.rankingScore);

  const sortKey = uiState.homeCriterion || 'finalScore';
  const sortedForPodium = [...cakes].sort((a, b) => {
    const diff = Number(b[sortKey] || 0) - Number(a[sortKey] || 0);
    return diff !== 0 ? diff : b.finalScore - a.finalScore;
  });

  const top3 = sortedForPodium.slice(0, 3);
  const latestCakes = [...cakes]
    .sort((a, b) => String(b.latestVisit).localeCompare(String(a.latestVisit)))
    .slice(0, 6);

  const championCake = top3[0] || cakes[0];

  updateSEOMeta({
    title: 'Início — Os Melhores Bolos de Feira de Santana',
    description: state.settings?.subtitle,
    image: championCake?.photos?.[0] || '/assets/og-sugarcube.svg',
    jsonLd: {
      '@context': 'https://schema.org',
      '@type': 'WebSite',
      name: 'Sugarcube Corner',
      url: window.location.origin,
      description: state.settings?.subtitle,
      author: { '@type': 'Person', name: 'Kai Tavares' }
    }
  });

  mainEl.innerHTML = `
    <!-- HERO SECTION -->
    <section class="hero-section">
      <div class="container">
        <div class="hero-card-stage">
          <img src="/assets/spike-peeking.png" alt="" aria-hidden="true" class="hero-spike-peeking" />
          <div class="hero-card">
          ${renderHeroPonyWatermarkSVG()}
          <div class="hero-content">
            <span class="eyebrow-tag"><img src="/assets/mlp-twilight-star.png" alt="" aria-hidden="true" class="cutie-mini-icon" /> Confeitaria & Crítica Sensorial em Feira de Santana • BA</span>
            <h1 class="hero-title">
              Onde cada fatia é avaliada pela <em>textura</em>, pelo <em>ponto da massa</em> e pela verdade do sabor.
            </h1>
            <p class="hero-lead">
              Boas-vindas à <strong>Sugarcube Corner</strong>! Aqui é <strong>Kai Tavares</strong> — especialista em degustação de doces e fã de <em>My Little Pony</em>. Neste cantinho não existe nota comprada: provo a massa pura, analiso a estrutura e conto tudo com total sinceridade.
            </p>
            <div class="twilight-callout-card">
              <img src="/assets/mlp-twilight-happy.png" alt="" aria-hidden="true" class="twilight-callout-avatar" />
              <div style="font-size:0.9rem;color:var(--text-espresso);">
                <strong><img src="/assets/mlp-butterflies.png" alt="" aria-hidden="true" class="cutie-mini-icon" /> O Olhar Sensorial de Kai:</strong> Percebo, logo na primeira mordida, a textura na boca, a qualidade dos ingredientes, a quantidade de recheio e se a massa está no ponto perfeito. Pode confiar: você receberá uma avaliação com total sinceridade e sem passar pano!
              </div>
            </div>
            <div class="hero-cta-row">
              <a href="/ranking" class="btn btn-primary"><span aria-hidden="true">🏆</span> Ver Ranking (${cakes.length} ${cakes.length === 1 ? 'bolo' : 'bolos'})</a>
              <a href="/mapa" class="btn btn-secondary"><span aria-hidden="true">🗺️</span> Mapa de Feira de Santana</a>
              <a href="/sobre" class="btn btn-caramel"><img src="/assets/mlp-twilight-star.png" alt="" aria-hidden="true" class="cutie-mini-icon" /> Como Kai avalia</a>
            </div>
          </div>

          ${
            championCake
              ? `
          <div class="hero-visual">
            <a href="/bolo/${encodeURIComponent(championCake.slug)}" class="hero-photo-frame">
              <img src="${escapeHTML(championCake.photos?.[0] || '/assets/og-sugarcube.svg')}" alt="Foto destaque: ${escapeHTML(championCake.name)}" />
            </a>
            <div class="hero-floating-card">
              <div>
                <span class="kai-seal"><span aria-hidden="true">👑</span> #1 Atual em Feira de Santana</span>
                <h2 style="font-family:var(--font-display);font-size:1.02rem;margin-top:0.2rem;">
                  <a href="/bolo/${encodeURIComponent(championCake.slug)}">${escapeHTML(championCake.name)}</a>
                </h2>
                <small style="color:var(--text-muted);">${escapeHTML(championCake.bakery?.name)} • ${escapeHTML(championCake.bakery?.neighborhood)}</small>
              </div>
              <div style="text-align:right;">
                <span style="font-family:var(--font-mono);font-size:1.55rem;font-weight:700;color:var(--raspberry);">${championCake.finalScore.toFixed(1)}</span>
                <small style="display:block;font-size:0.68rem;color:var(--text-muted);">NOTA DE KAI</small>
              </div>
            </div>
          </div>
          `
              : `
          <div class="hero-visual">
            <div class="detail-card" style="text-align:center;padding:2.2rem 1.5rem;background:rgba(255,255,255,0.92);">
              <div aria-hidden="true"><img src="/assets/sugarcube-icon.png" alt="" class="site-cupcake-hero" /></div>
              <h2 style="font-family:var(--font-display);font-size:1.35rem;margin-bottom:0.4rem;">Vitrine Pronta para as Avaliações de Kai</h2>
              <p style="font-size:0.9rem;color:var(--text-mocha);margin-bottom:1.1rem;">
                O site está limpo e sem avaliações fictícias. Assim que Kai cadastrar as primeiras confeitarias e fatias reais no painel, o Top 3 aparecerá aqui!
              </p>
              <div style="display:flex;gap:0.6rem;justify-content:center;flex-wrap:wrap;">
                <a href="/admin" class="btn btn-primary btn-sm">Cadastrar 1ª Avaliação (Kai)</a>
                <a href="/em-breve" class="btn btn-secondary btn-sm">Sugerir Confeitaria</a>
              </div>
            </div>
          </div>
          `
          }
          </div>
        </div>
      </div>
    </section>

    ${
      cakes.length > 0
        ? `
    <!-- TOP 3 PÓDIO DINÂMICO -->
    <section class="section-block">
      <div class="container">
        <div class="section-header">
          <div>
            <span class="eyebrow-tag"><img src="/assets/mlp-twilight-star.png" alt="" aria-hidden="true" class="cutie-mini-icon" /> Pódio Oficial • Edição 2026</span>
            <h2 class="section-title">Top 3 Bolos de Feira de Santana</h2>
            <p class="section-subtitle">Selecione um critério para reordenar o pódio:</p>
          </div>
          <div class="criteria-pill-bar" role="tablist" aria-label="Ordenar Top 3 por critério">
            <button type="button" class="criterion-sort-btn ${sortKey === 'finalScore' ? 'active' : ''}" data-home-crit="finalScore">
              Nota Geral
            </button>
            <button type="button" class="criterion-sort-btn ${sortKey === 'scoreTexture' ? 'active' : ''}" data-home-crit="scoreTexture">
              Melhor Textura
            </button>
            <button type="button" class="criterion-sort-btn ${sortKey === 'scoreDough' ? 'active' : ''}" data-home-crit="scoreDough">
              Melhor Massa
            </button>
            <button type="button" class="criterion-sort-btn ${sortKey === 'scoreFlavor' ? 'active' : ''}" data-home-crit="scoreFlavor">
              Melhor Sabor
            </button>
            <button type="button" class="criterion-sort-btn ${sortKey === 'scoreFilling' ? 'active' : ''}" data-home-crit="scoreFilling">
              Melhor Recheio
            </button>
          </div>
        </div>

        <div class="podium-grid">
          ${top3.map((cake, idx) => renderCakeCardHTML(cake, idx, sortKey)).join('')}
        </div>
      </div>
    </section>

    <!-- RANKING DAS CONFEITARIAS -->
    <section class="section-block" style="background:linear-gradient(180deg, var(--raspberry-soft) 0%, var(--bg-brioche) 100%);border-top:2px solid var(--raspberry-border);border-bottom:2px solid var(--raspberry-border);">
      <div class="container">
        <div class="section-header">
          <div>
            <span class="eyebrow-tag"><span aria-hidden="true">🧁</span> Consistência da Vitrine</span>
            <h2 class="section-title">Melhores Confeitarias de Feira</h2>
            <p class="section-subtitle">Ranking ponderado pelo número de bolos avaliados (mínimo de ${state.settings?.minCakesForConsolidatedRank || 2} avaliações para nota consolidada).</p>
          </div>
          <a href="/ranking?tab=bakeries" class="btn btn-secondary btn-sm">Ver todas as confeitarias →</a>
        </div>

        <div class="podium-grid">
          ${bakeries
            .slice(0, 3)
            .map(
              (b, idx) => `
            <article class="cake-card ${idx === 0 ? 'rank-1' : ''}">
              <div class="card-media">
                <span class="rank-medal ${idx === 0 ? 'medal-1' : idx === 1 ? 'medal-2' : 'medal-3'}">#${idx + 1}</span>
                <a href="/confeitaria/${encodeURIComponent(b.slug)}">
                  <img src="${escapeHTML(b.coverPhoto || '/assets/og-sugarcube.svg')}" alt="Foto da confeitaria ${escapeHTML(b.name)}" loading="lazy" />
                </a>
                <div class="score-badge-floating">
                  <span class="score-num">${b.overallScore.toFixed(1)}</span>
                  <span class="score-lbl">${b.cakesCount} bolo(s)</span>
                </div>
              </div>
              <div class="card-body">
                <div class="card-meta-top">
                  <span class="neighborhood-tag"><span aria-hidden="true">📍</span> ${escapeHTML(b.neighborhood)}</span>
                  ${b.kaiApproved ? `<span class="kai-seal"><span aria-hidden="true">🎈</span> Casa Aprovada por Kai</span>` : ''}
                  ${!b.isConsolidated ? `<span class="stale-review-badge">${b.cakesCount} avaliação (em consolidação)</span>` : ''}
                </div>
                <h3 class="card-title">
                  <a href="/confeitaria/${encodeURIComponent(b.slug)}">${escapeHTML(b.name)}</a>
                </h3>
                <p style="font-size:0.88rem;color:var(--text-mocha);">${escapeHTML(b.description)}</p>
                <div class="card-footer">
                  <span>Faixa: <strong>${escapeHTML(b.priceRange)}</strong> • ${b.cakesCount} bolo(s) avaliado(s)</span>
                  <a href="/confeitaria/${encodeURIComponent(b.slug)}" class="btn btn-primary btn-sm">Ver Confeitaria →</a>
                </div>
              </div>
            </article>
          `
            )
            .join('')}
        </div>
      </div>
    </section>

    <!-- ÚLTIMAS AVALIAÇÕES DE KAI -->
    <section class="section-block">
      <div class="container">
        <div class="section-header">
          <div>
            <span class="eyebrow-tag"><span aria-hidden="true">🦄</span> Diário de Degustação</span>
            <h2 class="section-title">Últimas Avaliações de Kai</h2>
            <p class="section-subtitle">Fatias provadas recentemente nos bairros de Feira de Santana.</p>
          </div>
          <a href="/ranking" class="btn btn-primary btn-sm">Explorar todos e filtrar →</a>
        </div>

        <div class="podium-grid">
          ${latestCakes.map((cake) => renderCakeCardHTML(cake, null, 'finalScore')).join('')}
        </div>
      </div>
    </section>
    `
        : ''
    }
  `;

  mainEl.querySelectorAll('[data-home-crit]').forEach((btn) => {
    btn.addEventListener('click', () => {
      uiState.homeCriterion = btn.getAttribute('data-home-crit');
      renderHomeView();
    });
  });

  bindStoryButtons();
}

/* ==========================================================================
   2. PÁGINA DE RANKING COMPLETO (/ranking)
   ========================================================================== */
function renderRankingView(queryParams = {}) {
  if (queryParams.sort) {
    const mapSort = {
      texture: 'scoreTexture',
      dough: 'scoreDough',
      flavor: 'scoreFlavor',
      filling: 'scoreFilling',
      price: 'priceAsc'
    };
    uiState.rankingSort = mapSort[queryParams.sort] || queryParams.sort;
  }
  if (queryParams.tab === 'bakeries') {
    uiState.rankingTab = 'bakeries';
  }
  if (queryParams.neighborhood) {
    uiState.rankingNeighborhood = queryParams.neighborhood;
  }

  const state = getState();
  const activeWeights = uiState.visitorCustomWeights || state.settings.weights;
  const allCakes = getEnrichedCakes(activeWeights);
  const allBakeries = getEnrichedBakeries(activeWeights);

  const neighborhoods = Array.from(
    new Set(state.bakeries.map((b) => b.neighborhood).filter(Boolean))
  ).sort();
  const categories = Array.from(
    new Set(state.cakes.map((c) => c.category).filter(Boolean))
  ).sort();
  const years = Array.from(
    new Set(state.cakes.map((c) => String(c.editionYear || 2026)))
  ).sort((a, b) => b.localeCompare(a));

  const filteredCakes = allCakes
    .filter((c) => {
      if (uiState.rankingOnlyApproved && !c.kaiApproved) return false;
      if (
        uiState.rankingNeighborhood !== 'all' &&
        c.bakery?.neighborhood !== uiState.rankingNeighborhood
      )
        return false;
      if (uiState.rankingCategory !== 'all' && c.category !== uiState.rankingCategory)
        return false;
      if (uiState.rankingPrice !== 'all' && c.bakery?.priceRange !== uiState.rankingPrice)
        return false;
      if (
        uiState.rankingYear !== 'all' &&
        String(c.editionYear || 2026) !== uiState.rankingYear
      )
        return false;
      if (uiState.rankingSearch.trim()) {
        const q = uiState.rankingSearch.toLowerCase();
        const match =
          c.name.toLowerCase().includes(q) ||
          c.flavorType.toLowerCase().includes(q) ||
          c.bakery?.name.toLowerCase().includes(q) ||
          c.kaiVerdict.toLowerCase().includes(q);
        if (!match) return false;
      }
      return true;
    })
    .sort((a, b) => {
      if (uiState.rankingSort === 'priceAsc') return a.approxPrice - b.approxPrice;
      const key = uiState.rankingSort || 'finalScore';
      const diff = Number(b[key] || 0) - Number(a[key] || 0);
      return diff !== 0 ? diff : b.finalScore - a.finalScore;
    });

  const filteredBakeries = allBakeries
    .filter((b) => {
      if (uiState.rankingOnlyApproved && !b.kaiApproved) return false;
      if (
        uiState.rankingNeighborhood !== 'all' &&
        b.neighborhood !== uiState.rankingNeighborhood
      )
        return false;
      if (uiState.rankingPrice !== 'all' && b.priceRange !== uiState.rankingPrice)
        return false;
      if (uiState.rankingSearch.trim()) {
        const q = uiState.rankingSearch.toLowerCase();
        const match =
          b.name.toLowerCase().includes(q) ||
          b.neighborhood.toLowerCase().includes(q) ||
          b.description.toLowerCase().includes(q);
        if (!match) return false;
      }
      return true;
    })
    .sort((a, b) => {
      const mapBakerySort = {
        finalScore: 'rankingScore',
        scoreTexture: 'avgTexture',
        scoreDough: 'avgDough',
        scoreFlavor: 'avgFlavor',
        scoreFilling: 'avgFilling'
      };
      const bKey = mapBakerySort[uiState.rankingSort] || 'rankingScore';
      return Number(b[bKey] || 0) - Number(a[bKey] || 0);
    });

  updateSEOMeta({
    title: 'Ranking Completo de Bolos e Confeitarias em Feira de Santana',
    description:
      'Ordene os melhores bolos de Feira de Santana por Textura, Massa, Sabor ou Recheio. Avaliações sinceras de Kai Tavares.'
  });

  mainEl.innerHTML = `
    <section class="section-block">
      <div class="container">
        <div class="section-header">
          <div>
            <span class="eyebrow-tag"><span aria-hidden="true">🏆</span> Guia Interativo • Feira de Santana - BA</span>
            <h1 class="section-title">Ranking Sugarcube Corner</h1>
            <p class="section-subtitle">Filtre por bairro, categoria ou reordene pelo critério que mais importa para o seu paladar.</p>
          </div>

          <div class="view-mode-tabs" role="tablist">
            <button type="button" class="view-tab-btn ${uiState.rankingTab === 'cakes' ? 'active' : ''}" data-rank-tab="cakes">
              <span aria-hidden="true">🧁</span> Bolos Avaliados (${filteredCakes.length})
            </button>
            <button type="button" class="view-tab-btn ${uiState.rankingTab === 'bakeries' ? 'active' : ''}" data-rank-tab="bakeries">
              <span aria-hidden="true">🏪</span> Confeitarias (${filteredBakeries.length})
            </button>
          </div>
        </div>

        <div class="filter-panel">
          <div class="filter-grid">
            <div class="form-group">
              <label class="form-label" for="f-search">Buscar bolo, sabor ou casa</label>
              <input type="search" id="f-search" class="form-input" placeholder="Ex: Pistache, Red Velvet, Cenoura..." value="${escapeHTML(uiState.rankingSearch)}" />
            </div>

            <div class="form-group">
              <label class="form-label" for="f-neighborhood">Bairro (Feira de Santana)</label>
              <select id="f-neighborhood" class="form-select">
                <option value="all">Todos os bairros</option>
                ${neighborhoods
                  .map(
                    (n) =>
                      `<option value="${escapeHTML(n)}" ${uiState.rankingNeighborhood === n ? 'selected' : ''}>${escapeHTML(n)}</option>`
                  )
                  .join('')}
              </select>
            </div>

            <div class="form-group">
              <label class="form-label" for="f-category">Categoria de Bolo</label>
              <select id="f-category" class="form-select" ${uiState.rankingTab === 'bakeries' ? 'disabled' : ''}>
                <option value="all">Todas as categorias</option>
                ${categories
                  .map(
                    (cat) =>
                      `<option value="${escapeHTML(cat)}" ${uiState.rankingCategory === cat ? 'selected' : ''}>${escapeHTML(cat)}</option>`
                  )
                  .join('')}
              </select>
            </div>

            <div class="form-group">
              <label class="form-label" for="f-price">Faixa de Preço</label>
              <select id="f-price" class="form-select">
                <option value="all">Qualquer faixa</option>
                <option value="$" ${uiState.rankingPrice === '$' ? 'selected' : ''}>$ (Econômico / Dia a dia)</option>
                <option value="$$" ${uiState.rankingPrice === '$$' ? 'selected' : ''}>$$ (Intermediário)</option>
                <option value="$$$" ${uiState.rankingPrice === '$$$' ? 'selected' : ''}>$$$ (Patisserie / Especial)</option>
              </select>
            </div>

            <div class="form-group">
              <label class="form-label" for="f-year">Edição Histórica</label>
              <select id="f-year" class="form-select">
                <option value="all">Todas as edições</option>
                ${years
                  .map(
                    (y) =>
                      `<option value="${y}" ${uiState.rankingYear === y ? 'selected' : ''}>Melhores de ${y}</option>`
                  )
                  .join('')}
              </select>
            </div>
          </div>

          <div style="margin-top:1.1rem;">
            <span class="form-label" style="display:block;margin-bottom:0.45rem;">Reordenar Ranking por Critério Individual:</span>
            <div class="criteria-pill-bar">
              <button type="button" class="criterion-sort-btn ${uiState.rankingSort === 'finalScore' ? 'active' : ''}" data-sort-crit="finalScore">
                Nota Geral
              </button>
              <button type="button" class="criterion-sort-btn ${uiState.rankingSort === 'scoreTexture' ? 'active' : ''}" data-sort-crit="scoreTexture">
                Melhor Textura
              </button>
              <button type="button" class="criterion-sort-btn ${uiState.rankingSort === 'scoreDough' ? 'active' : ''}" data-sort-crit="scoreDough">
                Melhor Massa
              </button>
              <button type="button" class="criterion-sort-btn ${uiState.rankingSort === 'scoreFlavor' ? 'active' : ''}" data-sort-crit="scoreFlavor">
                Melhor Sabor
              </button>
              <button type="button" class="criterion-sort-btn ${uiState.rankingSort === 'scoreFilling' ? 'active' : ''}" data-sort-crit="scoreFilling">
                Melhor Recheio
              </button>
              ${
                uiState.rankingTab === 'cakes'
                  ? `<button type="button" class="criterion-sort-btn ${uiState.rankingSort === 'priceAsc' ? 'active' : ''}" data-sort-crit="priceAsc">
                      Menor Preço
                    </button>`
                  : ''
              }
            </div>
          </div>

          <div class="filter-bottom-bar">
            <label class="toggle-check">
              <input type="checkbox" id="f-only-approved" ${uiState.rankingOnlyApproved ? 'checked' : ''} />
              <span>Mostrar apenas com selo <strong>"Aprovado por Kai"</strong> (Nota ≥ ${Number(state.settings.approvalThreshold).toFixed(1)})</span>
            </label>

            <div style="display:flex;gap:0.6rem;flex-wrap:wrap;">
              <button type="button" class="btn btn-caramel btn-sm" id="toggle-weights-sim">
                <span aria-hidden="true">⚖️</span> ${uiState.showWeightSimulator ? 'Ocultar Pesos da Média' : 'Simular Pesos da Média'}
              </button>
              <button type="button" class="btn btn-secondary btn-sm" id="clear-filters-btn">
                Limpar Filtros
              </button>
            </div>
          </div>

          ${
            uiState.showWeightSimulator
              ? `
            <div style="margin-top:1rem;padding:1rem;background:var(--bg-cream);border-radius:var(--radius-sm);border:1px solid var(--border-warm);">
              <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:0.5rem;margin-bottom:0.75rem;">
                <div>
                  <strong>Simulador de Média Ponderada</strong>
                  <p style="font-size:0.82rem;color:var(--text-muted);">Ajuste os pesos abaixo se quiser ver como o ranking fica priorizando o seu critério favorito:</p>
                </div>
                <button type="button" class="btn btn-secondary btn-sm" id="reset-visitor-weights">Usar Pesos Oficiais de Kai</button>
              </div>
              <div class="filter-grid" style="grid-template-columns:repeat(auto-fit,minmax(180px,1fr));">
                <div class="slider-score-group">
                  <div class="slider-score-header">
                    <span>Textura</span>
                    <span class="slider-score-val">${activeWeights.texture}%</span>
                  </div>
                  <input type="range" min="0" max="100" step="5" value="${activeWeights.texture}" class="score-range js-sim-weight" data-wkey="texture" />
                </div>
                <div class="slider-score-group">
                  <div class="slider-score-header">
                    <span>Massa</span>
                    <span class="slider-score-val">${activeWeights.dough}%</span>
                  </div>
                  <input type="range" min="0" max="100" step="5" value="${activeWeights.dough}" class="score-range js-sim-weight" data-wkey="dough" />
                </div>
                <div class="slider-score-group">
                  <div class="slider-score-header">
                    <span>Sabor</span>
                    <span class="slider-score-val">${activeWeights.flavor}%</span>
                  </div>
                  <input type="range" min="0" max="100" step="5" value="${activeWeights.flavor}" class="score-range js-sim-weight" data-wkey="flavor" />
                </div>
                <div class="slider-score-group">
                  <div class="slider-score-header">
                    <span>Recheio</span>
                    <span class="slider-score-val">${activeWeights.filling}%</span>
                  </div>
                  <input type="range" min="0" max="100" step="5" value="${activeWeights.filling}" class="score-range js-sim-weight" data-wkey="filling" />
                </div>
              </div>
            </div>
          `
              : ''
          }
        </div>

        ${
          uiState.rankingTab === 'cakes'
            ? filteredCakes.length > 0
              ? `<div class="podium-grid">
                  ${filteredCakes
                    .map((cake, idx) => renderCakeCardHTML(cake, idx, uiState.rankingSort))
                    .join('')}
                </div>`
              : `<div class="detail-card" style="text-align:center;padding:3rem 1.5rem;">
                  <div aria-hidden="true"><img src="/assets/sugarcube-icon.png" alt="" class="site-cupcake-hero" /></div>
                  <h3>${allCakes.length === 0 ? 'Ainda não há avaliações publicadas por Kai' : 'Nenhum bolo encontrado com esses filtros'}</h3>
                  <p style="color:var(--text-muted);margin:0.5rem 0 1.2rem;">
                    ${allCakes.length === 0 ? 'Acesse a Área de Kai para cadastrar a primeira avaliação real ou envie uma sugestão!' : 'Tente limpar os filtros ou sugerir uma nova confeitaria para Kai avaliar!'}
                  </p>
                  <div style="display:flex;gap:0.6rem;justify-content:center;flex-wrap:wrap;">
                    ${allCakes.length === 0 ? `<a href="/admin" class="btn btn-primary">Abrir Painel de Kai</a>` : `<button type="button" class="btn btn-primary" id="empty-clear-btn">Mostrar todos os bolos</button>`}
                    <a href="/em-breve" class="btn btn-secondary">Sugerir Confeitaria</a>
                  </div>
                </div>`
            : filteredBakeries.length > 0
            ? `<div class="podium-grid">
                ${filteredBakeries
                  .map(
                    (b, idx) => `
                  <article class="cake-card ${idx === 0 ? 'rank-1' : ''}">
                    <div class="card-media">
                      <span class="rank-medal ${idx === 0 ? 'medal-1' : idx === 1 ? 'medal-2' : idx === 2 ? 'medal-3' : ''}">#${idx + 1}</span>
                      <a href="/confeitaria/${encodeURIComponent(b.slug)}">
                        <img src="${escapeHTML(b.coverPhoto || '/assets/og-sugarcube.svg')}" alt="Foto da confeitaria ${escapeHTML(b.name)}" loading="lazy" />
                      </a>
                      <div class="score-badge-floating">
                        <span class="score-num">${b.overallScore.toFixed(1)}</span>
                        <span class="score-lbl">Média (${b.cakesCount})</span>
                      </div>
                    </div>
                    <div class="card-body">
                      <div class="card-meta-top">
                        <span class="neighborhood-tag"><span aria-hidden="true">📍</span> ${escapeHTML(b.neighborhood)}</span>
                        ${b.kaiApproved ? `<span class="kai-seal"><span aria-hidden="true">🎈</span> Aprovado por Kai</span>` : ''}
                        ${!b.isConsolidated ? `<span class="stale-review-badge">${b.cakesCount} bolo avaliado (mín. ${state.settings?.minCakesForConsolidatedRank || 2})</span>` : ''}
                        ${b.isFeaturedPartner ? `<span class="partner-badge">Vitrine Parceira</span>` : ''}
                      </div>
                      <h3 class="card-title">
                        <a href="/confeitaria/${encodeURIComponent(b.slug)}">${escapeHTML(b.name)}</a>
                      </h3>
                      <p style="font-size:0.86rem;color:var(--text-mocha);">${escapeHTML(b.description)}</p>
                      <div class="mini-criteria-grid">
                        <div class="mini-crit-box ${uiState.rankingSort === 'scoreTexture' ? 'highlight-crit' : ''}">
                          <span class="mini-crit-label">Textura</span>
                          <span class="mini-crit-val">${b.avgTexture.toFixed(1)}</span>
                        </div>
                        <div class="mini-crit-box ${uiState.rankingSort === 'scoreDough' ? 'highlight-crit' : ''}">
                          <span class="mini-crit-label">Massa</span>
                          <span class="mini-crit-val">${b.avgDough.toFixed(1)}</span>
                        </div>
                        <div class="mini-crit-box ${uiState.rankingSort === 'scoreFlavor' ? 'highlight-crit' : ''}">
                          <span class="mini-crit-label">Sabor</span>
                          <span class="mini-crit-val">${b.avgFlavor.toFixed(1)}</span>
                        </div>
                        <div class="mini-crit-box ${uiState.rankingSort === 'scoreFilling' ? 'highlight-crit' : ''}">
                          <span class="mini-crit-label">Recheio</span>
                          <span class="mini-crit-val">${b.avgFilling.toFixed(1)}</span>
                        </div>
                      </div>
                      <div style="display:flex;justify-content:space-between;font-size:0.75rem;color:var(--text-muted);padding-top:0.25rem;">
                        <span>Última visita: ${b.lastVisitedAt ? formatDateBR(b.lastVisitedAt) : '—'}</span>
                        ${b.isStale ? `<span class="stale-review-badge"><span aria-hidden="true">⏳</span> +6 meses</span>` : ''}
                      </div>
                      <div class="card-footer">
                        <span><strong>${b.cakesCount}</strong> bolo(s) avaliado(s) • <strong>${escapeHTML(b.priceRange)}</strong></span>
                        <a href="/confeitaria/${encodeURIComponent(b.slug)}" class="btn btn-primary btn-sm">Abrir Confeitaria →</a>
                      </div>
                    </div>
                  </article>
                `
                  )
                  .join('')}
              </div>`
            : `<div class="detail-card" style="text-align:center;padding:3rem 1.5rem;">
                <h3>Nenhuma confeitaria cadastrada ainda.</h3>
                <p style="color:var(--text-muted);margin:0.5rem 0 1.2rem;">Cadastre a primeira confeitaria de Feira de Santana no Painel de Kai!</p>
                <a href="/admin" class="btn btn-primary">Ir para o Painel de Kai</a>
              </div>`
        }
      </div>
    </section>
  `;

  const searchInput = document.getElementById('f-search');
  if (searchInput) {
    searchInput.addEventListener('input', (e) => {
      uiState.rankingSearch = e.target.value;
      const pos = e.target.selectionStart;
      renderRankingView();
      const restored = document.getElementById('f-search');
      if (restored) {
        restored.focus();
        restored.setSelectionRange(pos, pos);
      }
    });
  }

  document.getElementById('f-neighborhood')?.addEventListener('change', (e) => {
    uiState.rankingNeighborhood = e.target.value;
    renderRankingView();
  });
  document.getElementById('f-category')?.addEventListener('change', (e) => {
    uiState.rankingCategory = e.target.value;
    renderRankingView();
  });
  document.getElementById('f-price')?.addEventListener('change', (e) => {
    uiState.rankingPrice = e.target.value;
    renderRankingView();
  });
  document.getElementById('f-year')?.addEventListener('change', (e) => {
    uiState.rankingYear = e.target.value;
    renderRankingView();
  });
  document.getElementById('f-only-approved')?.addEventListener('change', (e) => {
    uiState.rankingOnlyApproved = e.target.checked;
    renderRankingView();
  });

  mainEl.querySelectorAll('[data-rank-tab]').forEach((btn) => {
    btn.addEventListener('click', () => {
      uiState.rankingTab = btn.getAttribute('data-rank-tab');
      renderRankingView();
    });
  });

  mainEl.querySelectorAll('[data-sort-crit]').forEach((btn) => {
    btn.addEventListener('click', () => {
      uiState.rankingSort = btn.getAttribute('data-sort-crit');
      renderRankingView();
    });
  });

  const resetFilters = () => {
    uiState.rankingSearch = '';
    uiState.rankingNeighborhood = 'all';
    uiState.rankingCategory = 'all';
    uiState.rankingPrice = 'all';
    uiState.rankingYear = 'all';
    uiState.rankingSort = 'finalScore';
    uiState.rankingOnlyApproved = false;
    renderRankingView();
  };

  document.getElementById('clear-filters-btn')?.addEventListener('click', resetFilters);
  document.getElementById('empty-clear-btn')?.addEventListener('click', resetFilters);

  document.getElementById('toggle-weights-sim')?.addEventListener('click', () => {
    uiState.showWeightSimulator = !uiState.showWeightSimulator;
    renderRankingView();
  });

  document.getElementById('reset-visitor-weights')?.addEventListener('click', () => {
    uiState.visitorCustomWeights = null;
    showToast('Pesos oficiais de Kai restaurados!');
    renderRankingView();
  });

  mainEl.querySelectorAll('.js-sim-weight').forEach((slider) => {
    slider.addEventListener('change', (e) => {
      const key = e.target.getAttribute('data-wkey');
      const current = uiState.visitorCustomWeights || { ...state.settings.weights };
      current[key] = Number(e.target.value);
      uiState.visitorCustomWeights = current;
      renderRankingView();
    });
  });

  bindStoryButtons();
}

/* ==========================================================================
   3. PÁGINA DA CONFEITARIA (/confeitaria/:slug)
   ========================================================================== */
function renderBakeryDetailView(slug) {
  const state = getState();
  const bakeries = getEnrichedBakeries();
  const bakery = bakeries.find((b) => b.slug === slug || b.id === slug);

  if (!bakery) {
    mainEl.innerHTML = `
      <div class="container section-block">
        <div class="detail-card" style="text-align:center;">
          <h2>Confeitaria não encontrada</h2>
          <p style="margin:0.75rem 0;"><a href="/ranking" class="btn btn-primary">Voltar ao Ranking</a></p>
        </div>
      </div>
    `;
    return;
  }

  const allPhotos = [
    bakery.coverPhoto,
    ...bakery.cakes.flatMap((c) => c.photos || [])
  ].filter(Boolean);

  const whatsappUrl = bakery.whatsapp
    ? `https://wa.me/${bakery.whatsapp}?text=${encodeURIComponent(
        `Olá! Vi as avaliações da ${bakery.name} feitas por Kai Tavares no Sugarcube Corner e gostaria de saber o cardápio de hoje!`
      )}`
    : null;
  const mapsQueryUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
    `${bakery.name} ${bakery.address}`
  )}`;

  updateSEOMeta({
    title: `${bakery.name} (${bakery.neighborhood}) — Confeitaria em Feira de Santana`,
    description: bakery.description,
    image: bakery.coverPhoto
  });

  mainEl.innerHTML = `
    <div class="container">
      <nav class="breadcrumb-bar" aria-label="Breadcrumb">
        <a href="/">Início</a> <span aria-hidden="true">›</span>
        <a href="/ranking?tab=bakeries">Confeitarias</a> <span aria-hidden="true">›</span>
        <strong>${escapeHTML(bakery.name)}</strong>
      </nav>

      <div class="review-detail-grid">
        <div>
          <div class="detail-card">
            <div class="review-gallery-main">
              <img src="${escapeHTML(bakery.coverPhoto || '/assets/og-sugarcube.svg')}" alt="Foto de capa da confeitaria ${escapeHTML(bakery.name)}" />
            </div>

            <div style="display:flex;gap:0.5rem;flex-wrap:wrap;margin-bottom:0.65rem;">
              <span class="neighborhood-tag"><span aria-hidden="true">📍</span> ${escapeHTML(bakery.neighborhood)} • Feira de Santana</span>
              <span class="neighborhood-tag">Faixa: ${escapeHTML(bakery.priceRange)}</span>
              <span class="neighborhood-tag">${bakery.cakesCount} bolo(s) avaliado(s)</span>
              ${bakery.kaiApproved ? `<span class="kai-seal kai-seal-lg"><span aria-hidden="true">🎈</span> Confeitaria Aprovada por Kai</span>` : ''}
              ${bakery.isStale ? `<span class="stale-review-badge"><span aria-hidden="true">⏳</span> Última visita há mais de 6 meses (${formatDateBR(bakery.lastVisitedAt)})</span>` : ''}
              ${
                bakery.isFeaturedPartner
                  ? `<span class="partner-badge" title="Apoio institucional de vitrine. As notas continuam 100% independentes.">Vitrine Parceira (Nota Independente)</span>`
                  : ''
              }
            </div>

            <h1 class="section-title" style="font-size:clamp(1.65rem,3.5vw,2.3rem);margin-bottom:0.75rem;">
              ${escapeHTML(bakery.name)}
            </h1>

            <p style="font-size:1.02rem;color:var(--text-mocha);margin-bottom:1.25rem;">
              ${escapeHTML(bakery.description)}
            </p>

            <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:0.85rem;background:var(--bg-cream);padding:1.1rem;border-radius:var(--radius-md);border:1px solid var(--border-warm);margin-bottom:1.25rem;">
              <div>
                <small class="form-label">Endereço</small>
                <p style="font-size:0.9rem;font-weight:600;">${escapeHTML(bakery.address)}</p>
              </div>
              <div>
                <small class="form-label">Horário de Funcionamento</small>
                <p style="font-size:0.9rem;font-weight:600;">${escapeHTML(bakery.openingHours || 'Consultar na casa')}</p>
              </div>
              <div>
                <small class="form-label">Instagram & Última Visita</small>
                <p style="font-size:0.9rem;font-weight:600;color:var(--raspberry);">
                  ${escapeHTML(bakery.instagram || '—')}
                  ${bakery.lastVisitedAt ? `<br/><small style="color:var(--text-muted);">Última visita: ${formatDateBR(bakery.lastVisitedAt)}</small>` : ''}
                </p>
              </div>
            </div>

            <div style="display:flex;flex-wrap:wrap;gap:0.75rem;">
              ${
                whatsappUrl
                  ? `<a href="${whatsappUrl}" target="_blank" rel="noopener" class="btn btn-whatsapp">
                      <span aria-hidden="true">💬</span> Chamar no WhatsApp
                    </a>`
                  : ''
              }
              <a href="${mapsQueryUrl}" target="_blank" rel="noopener" class="btn btn-secondary">
                <span aria-hidden="true">🗺️</span> Abrir Rota no Google Maps
              </a>
              <a href="/mapa" class="btn btn-caramel">
                <span aria-hidden="true">📍</span> Ver no Mapa do Site
              </a>
            </div>
          </div>

          <div style="margin-top:2rem;">
            <h2 class="section-title" style="margin-bottom:0.35rem;">
              Bolos Avaliados por Kai (${bakery.cakesCount})
            </h2>
            <p class="section-subtitle" style="margin-bottom:1.25rem;">
              A média simples da ${escapeHTML(bakery.name)} é <strong>${bakery.overallScore.toFixed(1)}</strong> baseada nos ${bakery.cakesCount} bolo(s) abaixo:
            </p>

            <div class="podium-grid" style="grid-template-columns:repeat(auto-fit,minmax(290px,1fr));">
              ${bakery.cakes.map((cake, idx) => renderCakeCardHTML(cake, idx, 'finalScore')).join('')}
            </div>
          </div>

          <div class="detail-card" style="margin-top:2rem;">
            <h3 class="section-title" style="font-size:1.3rem;margin-bottom:1rem;">Galeria da Casa & Fatias</h3>
            <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:0.75rem;">
              ${allPhotos
                .map(
                  (url, i) => `
                <div style="border-radius:12px;overflow:hidden;aspect-ratio:4/3;border:1px solid var(--border-warm);">
                  <img src="${escapeHTML(url)}" alt="Foto ${i + 1} da confeitaria ${escapeHTML(bakery.name)}" style="width:100%;height:100%;object-fit:cover;" loading="lazy" />
                </div>
              `
                )
                .join('')}
            </div>
          </div>
        </div>

        <aside>
          <div class="detail-card" style="position:sticky;top:88px;">
            <div class="score-hero-banner">
              <div>
                <span style="font-size:0.75rem;text-transform:uppercase;letter-spacing:0.06em;opacity:0.85;">Média dos Bolos</span>
                <h3 style="font-family:var(--font-display);font-size:1.25rem;">Desempenho Técnico</h3>
                <small style="opacity:0.8;">${bakery.cakesCount} bolo(s) avaliado(s)</small>
              </div>
              <div class="score-big-number">${bakery.overallScore.toFixed(1)}</div>
            </div>

            ${renderRadarChartSVG({
              texture: bakery.avgTexture,
              dough: bakery.avgDough,
              flavor: bakery.avgFlavor,
              filling: bakery.avgFilling
            })}

            ${renderCriteriaBarsHTML(bakery, state.settings.weights)}

            <div style="margin-top:1.25rem;padding-top:1rem;border-top:1px solid var(--border-subtle);display:flex;flex-direction:column;gap:0.6rem;">
              <a href="https://wa.me/?text=${encodeURIComponent(
                `Olha as notas da ${bakery.name} (${bakery.neighborhood}) no Sugarcube Corner por Kai Tavares: Nota Geral ${bakery.overallScore.toFixed(1)}/10! ${window.location.href}`
              )}" target="_blank" rel="noopener" class="btn btn-secondary btn-full">
                Compartilhar Confeitaria no WhatsApp
              </a>
            </div>
          </div>
        </aside>
      </div>
    </div>
  `;

  bindStoryButtons();
}

/* ==========================================================================
   4. PÁGINA DO BOLO / AVALIAÇÃO DETALHADA (/bolo/:slug)
   ========================================================================== */
function renderCakeDetailView(slug) {
  const state = getState();
  const cakes = getEnrichedCakes();
  const cake = cakes.find((c) => c.slug === slug || c.id === slug);

  if (!cake) {
    mainEl.innerHTML = `
      <div class="container section-block">
        <div class="detail-card" style="text-align:center;">
          <h2>Avaliação não encontrada</h2>
          <p style="margin:0.75rem 0;"><a href="/ranking" class="btn btn-primary">Voltar ao Ranking</a></p>
        </div>
      </div>
    `;
    return;
  }

  const sortedAll = [...cakes].sort((a, b) => b.finalScore - a.finalScore);
  const rankPosition = sortedAll.findIndex((c) => c.id === cake.id) + 1;

  updateSEOMeta({
    title: `${cake.name} (${cake.bakery?.name}) — Nota ${cake.finalScore.toFixed(1)}`,
    description: cake.kaiVerdict,
    image: cake.photos?.[0]
  });

  const shareWhatsappText = `🧁 *${cake.name}* na *${cake.bakery?.name}* (${cake.bakery?.neighborhood} - Feira de Santana)\n🏆 Nota Final de Kai Tavares: *${cake.finalScore.toFixed(1)}/10*\n🎈 Textura: ${cake.scoreTexture.toFixed(1)} | 🧁 Massa: ${cake.scoreDough.toFixed(1)} | 🍓 Sabor: ${cake.scoreFlavor.toFixed(1)} | 🍯 Recheio: ${cake.scoreFilling.toFixed(1)}\n\nLeia a avaliação completa no Sugarcube Corner: ${window.location.href}`;

  mainEl.innerHTML = `
    <div class="container">
      <nav class="breadcrumb-bar" aria-label="Breadcrumb">
        <a href="/">Início</a> <span aria-hidden="true">›</span>
        <a href="/ranking">Ranking</a> <span aria-hidden="true">›</span>
        <a href="/confeitaria/${encodeURIComponent(cake.bakery?.slug)}">${escapeHTML(cake.bakery?.name)}</a> <span aria-hidden="true">›</span>
        <strong>${escapeHTML(cake.name)}</strong>
      </nav>

      <div class="review-detail-grid">
        <div>
          <article class="detail-card">
            <div class="review-gallery-main">
              <img id="main-cake-photo" src="${escapeHTML(cake.photos?.[0] || '/assets/og-sugarcube.svg')}" alt="Foto principal do bolo ${escapeHTML(cake.name)}" />
            </div>

            ${
              cake.photos && cake.photos.length > 1
                ? `<div class="review-thumbs">
                    ${cake.photos
                      .map(
                        (url, i) => `
                      <button type="button" class="thumb-btn ${i === 0 ? 'active' : ''}" data-photo-url="${escapeHTML(url)}" aria-label="Ver foto ${i + 1} de ${escapeHTML(cake.name)}">
                        <img src="${escapeHTML(url)}" alt="Miniatura ${i + 1} de ${escapeHTML(cake.name)}" />
                      </button>
                    `
                      )
                      .join('')}
                  </div>`
                : ''
            }

            <div style="display:flex;gap:0.5rem;flex-wrap:wrap;align-items:center;margin-bottom:0.65rem;">
              <span class="neighborhood-tag"><span aria-hidden="true">🏆</span> #${rankPosition} no Ranking Geral de Feira</span>
              <span class="neighborhood-tag">${escapeHTML(cake.category)}</span>
              ${cake.kaiApproved ? `<span class="kai-seal kai-seal-lg"><span aria-hidden="true">🎈</span> Selo Aprovado por Kai</span>` : ''}
              ${cake.isStale ? `<span class="stale-review-badge"><span aria-hidden="true">⏳</span> Avaliado há mais de 6 meses — receita ou ponto podem ter mudado</span>` : ''}
            </div>

            <h1 class="section-title" style="font-size:clamp(1.6rem,3.5vw,2.25rem);margin-bottom:0.4rem;">
              ${escapeHTML(cake.name)}
            </h1>

            <p style="font-size:1rem;margin-bottom:1rem;">
              Confeitaria: <a href="/confeitaria/${encodeURIComponent(cake.bakery?.slug)}" style="color:var(--raspberry);font-weight:700;text-decoration:underline;">${escapeHTML(cake.bakery?.name)}</a>
              <span style="color:var(--text-muted);">• Bairro ${escapeHTML(cake.bakery?.neighborhood)}, Feira de Santana - BA</span>
            </p>

            <div style="display:flex;flex-wrap:wrap;gap:1.25rem;padding:0.85rem 1.1rem;background:var(--bg-cream);border-radius:var(--radius-sm);border:1px solid var(--border-subtle);font-size:0.88rem;">
              <span>Preço aprox.: <strong>${formatBRL(cake.approxPrice)}</strong></span>
              <span>Data da visita: <strong>${formatDateBR(cake.visitedAt)}</strong></span>
              <span>Edição: <strong>Melhores de ${cake.editionYear || 2026}</strong></span>
            </div>

            ${
              cake.reevaluatedAt
                ? `<div class="reevaluation-banner">
                    <strong>Reavaliado em ${formatDateBR(cake.reevaluatedAt)}:</strong>
                    ${escapeHTML(cake.reevaluationNote || 'Nota revisada por Kai em nova visita técnica.')}
                  </div>`
                : ''
            }

            <div class="kai-verdict-box">
              <div class="kai-verdict-header">
                <div class="kai-avatar-badge" aria-hidden="true">🦄</div>
                <div>
                  <strong style="display:block;font-size:0.98rem;">Análise de Kai Tavares</strong>
                  <span style="font-size:0.78rem;color:var(--text-muted);">Crítica Sensorial • Foco em Massa, Ponto & Textura</span>
                </div>
              </div>
              <div class="kai-verdict-text">${escapeHTML(cake.kaiVerdict)}</div>
            </div>

            <div style="margin-top:1.5rem;">
              <h2 style="font-family:var(--font-display);font-size:1.2rem;margin-bottom:0.3rem;">
                Raio-X Sensorial da Fatia
              </h2>
              <p style="font-size:0.85rem;color:var(--text-muted);margin-bottom:0.75rem;">
                Notas técnicas detalhadas sobre o comportamento físico da massa e do recheio no paladar:
              </p>
              <div class="sensory-xray-grid">
                <div class="sensory-xray-item">
                  <span class="sensory-xray-label">Ponto & Estrutura da Massa</span>
                  <span class="sensory-xray-val">${escapeHTML(cake.sensoryNotes?.crumbPoint || 'Bem estruturada')}</span>
                </div>
                <div class="sensory-xray-item">
                  <span class="sensory-xray-label">Umidade & Calda</span>
                  <span class="sensory-xray-val">${escapeHTML(cake.sensoryNotes?.moisture || 'Equilibrada')}</span>
                </div>
                <div class="sensory-xray-item">
                  <span class="sensory-xray-label">Sensação na Boca (Textura)</span>
                  <span class="sensory-xray-val">${escapeHTML(cake.sensoryNotes?.mouthfeel || 'Aveludada')}</span>
                </div>
                <div class="sensory-xray-item">
                  <span class="sensory-xray-label">Equilíbrio de Dulçor</span>
                  <span class="sensory-xray-val">${escapeHTML(cake.sensoryNotes?.sweetness || 'Moderado')}</span>
                </div>
              </div>
            </div>

            <!-- REAÇÕES RÁPIDAS COM TRAVA ANTI-SPAM -->
            <div style="margin-top:1.75rem;padding-top:1.25rem;border-top:1px solid var(--border-subtle);">
              <span class="form-label">O que você achou dessa avaliação? (1 reação por visitante)</span>
              <div class="reactions-bar">
                <button type="button" class="reaction-btn ${hasVisitorReacted(cake.id, 'waterInMouth') ? 'reacted' : ''}" data-react="waterInMouth">
                  <span aria-hidden="true">🤤</span> Deu água na boca <strong>(${cake.reactions?.waterInMouth || 0})</strong>
                </button>
                <button type="button" class="reaction-btn ${hasVisitorReacted(cake.id, 'agreeWithKai') ? 'reacted' : ''}" data-react="agreeWithKai">
                  <span aria-hidden="true">🎯</span> Concordo com Kai <strong>(${cake.reactions?.agreeWithKai || 0})</strong>
                </button>
                <button type="button" class="reaction-btn ${hasVisitorReacted(cake.id, 'wantToTry') ? 'reacted' : ''}" data-react="wantToTry">
                  <span aria-hidden="true">🧁</span> Quero provar em Feira <strong>(${cake.reactions?.wantToTry || 0})</strong>
                </button>
              </div>
            </div>
          </article>
        </div>

        <aside>
          <div class="detail-card" style="position:sticky;top:88px;">
            <div class="score-hero-banner">
              <div>
                <span style="font-size:0.75rem;text-transform:uppercase;letter-spacing:0.06em;opacity:0.85;">Nota Final Ponderada</span>
                <h2 style="font-family:var(--font-display);font-size:1.25rem;">Ficha de Notas</h2>
                <small style="opacity:0.8;">Escala de 0.0 a 10.0 (meio ponto)</small>
              </div>
              <div class="score-big-number">${cake.finalScore.toFixed(1)}</div>
            </div>

            ${renderRadarChartSVG({
              texture: cake.scoreTexture,
              dough: cake.scoreDough,
              flavor: cake.scoreFlavor,
              filling: cake.scoreFilling
            })}

            ${renderCriteriaBarsHTML(cake, state.settings.weights)}

            <div style="margin-top:1.4rem;padding-top:1.1rem;border-top:1px solid var(--border-subtle);display:flex;flex-direction:column;gap:0.65rem;">
              <button type="button" class="btn btn-primary btn-full js-open-story" data-cake-id="${escapeHTML(cake.id)}">
                <span aria-hidden="true">📸</span> Gerar Card para Stories (9:16)
              </button>
              <a href="https://wa.me/?text=${encodeURIComponent(shareWhatsappText)}" target="_blank" rel="noopener" class="btn btn-whatsapp btn-full">
                <span aria-hidden="true">📲</span> Compartilhar Avaliação no WhatsApp
              </a>
              <a href="/confeitaria/${encodeURIComponent(cake.bakery?.slug)}" class="btn btn-secondary btn-full">
                Ver perfil da ${escapeHTML(cake.bakery?.name)}
              </a>
            </div>
          </div>
        </aside>
      </div>
    </div>
  `;

  mainEl.querySelectorAll('[data-photo-url]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const mainImg = document.getElementById('main-cake-photo');
      if (mainImg) mainImg.src = btn.getAttribute('data-photo-url');
      mainEl.querySelectorAll('.thumb-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
    });
  });

  mainEl.querySelectorAll('[data-react]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const key = btn.getAttribute('data-react');
      try {
        await reactToCake(cake.id, key);
        showToast('Sua reação foi registrada!');
        renderCakeDetailView(slug);
      } catch (err) {
        showToast(err.message, true);
      }
    });
  });

  bindStoryButtons();
}

/* ==========================================================================
   5. MAPA INTERATIVO DAS CONFEITARIAS DE FEIRA DE SANTANA (/mapa)
   ========================================================================== */
function renderMapView() {
  const bakeries = getEnrichedBakeries().sort((a, b) => b.rankingScore - a.rankingScore);
  const neighborhoods = Array.from(new Set(bakeries.map((b) => b.neighborhood))).sort();

  const filtered = bakeries.filter(
    (b) => uiState.mapNeighborhood === 'all' || b.neighborhood === uiState.mapNeighborhood
  );

  updateSEOMeta({
    title: 'Mapa das Confeitarias de Feira de Santana',
    description:
      'Explore no mapa onde ficam os melhores bolos e confeitarias de Feira de Santana avaliados por Kai Tavares.'
  });

  mainEl.innerHTML = `
    <section class="section-block">
      <div class="container">
        <div class="section-header">
          <div>
            <span class="eyebrow-tag"><span aria-hidden="true">🗺️</span> Roteiro Doce • Feira de Santana - BA</span>
            <h1 class="section-title">Mapa das Confeitarias Avaliadas</h1>
            <p class="section-subtitle">Toque nos marcadores com as notas de Kai ou escolha um bairro ao lado.</p>
          </div>
          <div>
            <select id="map-neighborhood-select" class="form-select" style="min-width:220px;" aria-label="Filtrar mapa por bairro">
              <option value="all">Todos os bairros (${bakeries.length})</option>
              ${neighborhoods
                .map(
                  (n) =>
                    `<option value="${escapeHTML(n)}" ${uiState.mapNeighborhood === n ? 'selected' : ''}>${escapeHTML(n)}</option>`
                )
                .join('')}
            </select>
          </div>
        </div>

        <div class="map-layout">
          <div class="map-sidebar">
            ${
              filtered.length === 0
                ? `<div style="text-align:center;padding:2rem 1rem;color:var(--text-muted);">
                    <p>Nenhuma confeitaria cadastrada ainda no mapa.</p>
                    <p style="margin-top:0.75rem;"><a href="/admin" class="btn btn-primary btn-sm">Cadastrar no Painel de Kai</a></p>
                  </div>`
                : filtered
                    .map(
                      (b) => `
                  <div class="map-bakery-item" data-lat="${b.lat}" data-lng="${b.lng}" data-id="${escapeHTML(b.id)}">
                    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.25rem;">
                      <span class="neighborhood-tag">${escapeHTML(b.neighborhood)}</span>
                      <span style="font-family:var(--font-mono);font-weight:700;color:var(--raspberry);font-size:1rem;">★ ${b.overallScore.toFixed(1)} (${b.cakesCount})</span>
                    </div>
                    <h2 style="font-family:var(--font-display);font-size:1.05rem;">${escapeHTML(b.name)}</h2>
                    <p style="font-size:0.8rem;color:var(--text-muted);margin:0.2rem 0 0.5rem;">${escapeHTML(b.address)}</p>
                    <div style="display:flex;gap:0.5rem;">
                      <a href="/confeitaria/${encodeURIComponent(b.slug)}" class="btn btn-primary btn-sm" style="padding:0.3rem 0.7rem;font-size:0.76rem;">Ver Perfil</a>
                      <a href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(b.name + ' ' + b.address)}" target="_blank" rel="noopener" class="btn btn-secondary btn-sm" style="padding:0.3rem 0.7rem;font-size:0.76rem;">Rota GPS</a>
                    </div>
                  </div>
                `
                    )
                    .join('')
            }
          </div>

          <div id="leaflet-map" class="map-canvas-box" role="region" aria-label="Mapa de Feira de Santana"></div>
        </div>
      </div>
    </section>
  `;

  document.getElementById('map-neighborhood-select')?.addEventListener('change', (e) => {
    uiState.mapNeighborhood = e.target.value;
    renderMapView();
  });

  setTimeout(() => {
    const mapContainer = document.getElementById('leaflet-map');
    if (!mapContainer || typeof window.L === 'undefined') return;

    if (activeLeafletMap) {
      activeLeafletMap.remove();
      activeLeafletMap = null;
    }

    const L = window.L;
    activeLeafletMap = L.map('leaflet-map').setView([-12.2535, -38.952], 13);

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '© OpenStreetMap • Sugarcube Corner Feira de Santana'
    }).addTo(activeLeafletMap);

    const markersById = {};

    filtered.forEach((b) => {
      const icon = L.divIcon({
        className: 'custom-div-icon',
        html: `<div class="sugarcube-map-pin">${b.kaiApproved ? '🎈' : '🧁'} ${b.overallScore.toFixed(1)}</div>`,
        iconSize: [72, 32],
        iconAnchor: [36, 16]
      });

      const marker = L.marker([b.lat || -12.2545, b.lng || -38.955], { icon }).addTo(
        activeLeafletMap
      );

      marker.bindPopup(`
        <div style="font-family:'Plus Jakarta Sans',sans-serif;min-width:200px;">
          <strong style="font-size:0.95rem;color:#2A1420;">${escapeHTML(b.name)}</strong><br/>
          <span style="font-size:0.78rem;color:#785265;">${escapeHTML(b.neighborhood)} • Nota ${b.overallScore.toFixed(1)}/10 (${b.cakesCount} bolos)</span>
          <p style="font-size:0.78rem;margin:6px 0;">${escapeHTML(b.openingHours)}</p>
          <a href="/confeitaria/${encodeURIComponent(b.slug)}" style="display:inline-block;margin-top:4px;color:#C42865;font-weight:700;font-size:0.82rem;">Ver bolos avaliados →</a>
        </div>
      `);

      markersById[b.id] = marker;
    });

    mainEl.querySelectorAll('.map-bakery-item').forEach((card) => {
      card.addEventListener('click', (e) => {
        if (e.target.tagName === 'A') return;
        const lat = Number(card.getAttribute('data-lat'));
        const lng = Number(card.getAttribute('data-lng'));
        const id = card.getAttribute('data-id');
        if (activeLeafletMap && lat && lng) {
          activeLeafletMap.flyTo([lat, lng], 15, { duration: 0.6 });
          if (markersById[id]) markersById[id].openPopup();
        }
      });
    });
  }, 60);
}

/* ==========================================================================
   6. SEÇÃO "EM BREVE" & SUGESTÃO DO PÚBLICO (/em-breve)
   ========================================================================== */
function renderUpcomingView() {
  const state = getState();
  const upcoming = [...(state.upcomingBakeries || [])].sort((a, b) => b.votes - a.votes);

  updateSEOMeta({
    title: 'Em Breve & Sugestões — Qual bolo Kai deve provar em Feira?',
    description:
      'Vote nas próximas confeitarias que Kai Tavares vai visitar em Feira de Santana ou envie sua sugestão de bolo!'
  });

  mainEl.innerHTML = `
    <section class="section-block">
      <div class="container">
        <div class="section-header">
          <div>
            <span class="eyebrow-tag"><span aria-hidden="true">🎈</span> Radar da Comunidade • Feira de Santana</span>
            <h1 class="section-title">No Radar de Kai ("Em Breve")</h1>
            <p class="section-subtitle">Vote em qual confeitaria de Feira você quer ver avaliada primeiro ou indique um bolo especial!</p>
          </div>
        </div>

        <div class="review-detail-grid">
          <div>
            <h2 style="font-family:var(--font-display);font-size:1.35rem;margin-bottom:1rem;">
              Próximas Visitas Planejadas (Vote na sua favorita)
            </h2>
            ${
              upcoming.length === 0
                ? `<div class="detail-card" style="text-align:center;padding:2rem;">
                    <p style="color:var(--text-muted);">Nenhuma confeitaria na fila de votação ainda. Envie sua sugestão no formulário ao lado para estrear a lista!</p>
                  </div>`
                : `<div style="display:flex;flex-direction:column;gap:1rem;">
                    ${upcoming
                      .map(
                        (u, idx) => `
                      <div class="detail-card" style="display:flex;justify-content:space-between;align-items:center;gap:1rem;flex-wrap:wrap;">
                        <div style="flex:1;min-width:220px;">
                          <div style="display:flex;gap:0.5rem;align-items:center;margin-bottom:0.35rem;">
                            <span class="neighborhood-tag">#${idx + 1} mais pedido</span>
                            <span class="neighborhood-tag">${escapeHTML(u.neighborhood)}</span>
                            <span style="font-size:0.76rem;color:var(--raspberry);font-weight:700;">${escapeHTML(u.plannedMonth)}</span>
                          </div>
                          <h3 style="font-family:var(--font-display);font-size:1.2rem;">${escapeHTML(u.name)}</h3>
                          <p style="font-size:0.88rem;color:var(--text-espresso);margin-top:0.2rem;">
                            <strong>Na mira de Kai:</strong> ${escapeHTML(u.specialty)}
                          </p>
                          <p style="font-size:0.84rem;color:var(--text-muted);margin-top:0.2rem;font-style:italic;">
                            "${escapeHTML(u.reason)}"
                          </p>
                        </div>
                        <div style="text-align:center;">
                          <button type="button" class="btn ${hasVisitorVoted(u.id) ? 'btn-secondary' : 'btn-primary'} js-vote-upcoming" data-up-id="${escapeHTML(u.id)}">
                            <span aria-hidden="true">🎈</span> ${hasVisitorVoted(u.id) ? 'Voto Registrado' : 'Quero que Kai vá!'} (${u.votes})
                          </button>
                        </div>
                      </div>
                    `
                      )
                      .join('')}
                  </div>`
            }
          </div>

          <aside id="sugerir">
            <div class="detail-card">
              <div style="display:flex;align-items:center;gap:0.85rem;margin-bottom:0.85rem;">
                <img src="/assets/mlp-twilight-happy.png" alt="" aria-hidden="true" class="twilight-callout-avatar" />
                <div>
                  <span class="eyebrow-tag"><img src="/assets/mlp-butterflies.png" alt="" aria-hidden="true" class="cutie-mini-icon" /> Indique um Bolo para Kai</span>
                  <h2 style="font-family:var(--font-display);font-size:1.3rem;line-height:1.15;">
                    Conhece um bolo com massa e textura perfeitas?
                  </h2>
                </div>
              </div>
              <p style="font-size:0.88rem;color:var(--text-muted);margin-bottom:1.25rem;">
                Mande sua dica em Feira de Santana! As sugestões vão direto para a fila de moderação de Kai no painel administrativo.
              </p>

              <form id="public-suggestion-form" style="display:flex;flex-direction:column;gap:0.9rem;">
                <div class="form-group">
                  <label class="form-label" for="sug-bakery">Nome da Confeitaria / Doceria *</label>
                  <input type="text" id="sug-bakery" class="form-input" required placeholder="Ex: Atelier Doce..." />
                </div>

                <div class="form-group">
                  <label class="form-label" for="sug-neighborhood">Bairro em Feira de Santana *</label>
                  <input type="text" id="sug-neighborhood" class="form-input" required placeholder="Ex: Santa Mônica, Kalilândia, São João..." />
                </div>

                <div class="form-group">
                  <label class="form-label" for="sug-cake">Qual bolo Kai PRECISA provar lá? *</label>
                  <input type="text" id="sug-cake" class="form-input" required placeholder="Ex: Fatia de Pistache com Frutas Vermelhas" />
                </div>

                <div class="form-group">
                  <label class="form-label" for="sug-author">Seu nome (opcional)</label>
                  <input type="text" id="sug-author" class="form-input" placeholder="Ex: Lucas M." />
                </div>

                <div class="form-group">
                  <label class="form-label" for="sug-comment">O que a textura ou a massa desse bolo tem de especial? *</label>
                  <textarea id="sug-comment" rows="3" class="form-textarea" required placeholder="Conte se é bem molhadinho, se o recheio não é enjoativo..."></textarea>
                </div>

                <button type="submit" class="btn btn-primary btn-full">
                  Enviar Sugestão para Kai
                </button>
              </form>
            </div>
          </aside>
        </div>
      </div>
    </section>
  `;

  mainEl.querySelectorAll('.js-vote-upcoming').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const upId = btn.getAttribute('data-up-id');
      try {
        await voteUpcomingBakery(upId);
        showToast('Seu voto foi contabilizado na fila de Kai!');
        renderUpcomingView();
      } catch (err) {
        showToast(err.message, true);
      }
    });
  });

  document.getElementById('public-suggestion-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await submitPublicSuggestion({
        bakeryName: document.getElementById('sug-bakery').value,
        neighborhood: document.getElementById('sug-neighborhood').value,
        cakeSuggested: document.getElementById('sug-cake').value,
        submittedBy: document.getElementById('sug-author').value,
        comment: document.getElementById('sug-comment').value
      });
      e.target.reset();
      showToast('Sugestão enviada para Kai com sucesso!');
    } catch (err) {
      showToast(err.message, true);
    }
  });
}

/* ==========================================================================
   7. SOBRE KAI & METODOLOGIA (/sobre)
   ========================================================================== */
function renderAboutView() {
  const state = getState();
  const bio = state.settings?.kaiBio || {};
  const weights = state.settings?.weights || { flavor: 25, dough: 25, texture: 25, filling: 25 };

  updateSEOMeta({
    title: 'Sobre Kai Tavares & Metodologia Sensorial',
    description:
      'Entenda como Kai Tavares avalia Sabor, Massa, Textura e Recheio nos bolos de Feira de Santana com transparência total.'
  });

  mainEl.innerHTML = `
    <section class="section-block">
      <div class="container">
        <div class="review-detail-grid">
          <div>
            <div class="detail-card">
              <span class="eyebrow-tag"><img src="/assets/mlp-twilight-star.png" alt="" aria-hidden="true" class="cutie-mini-icon" /> A Voz por Trás do Ranking</span>
              <h1 class="section-title" style="font-size:clamp(1.75rem,3.5vw,2.4rem);margin-bottom:0.75rem;">
                ${escapeHTML(bio.title || 'Oi, eu sou Kai!')}
              </h1>

              <div class="kai-bio-word-flow">
                <p class="kai-bio-lead-para">
                  ${escapeHTML(bio.lead || '')}
                </p>

                <img src="/assets/kai-portrait-kouxhii.png" alt="Ilustração de Kai por @kouxhii" class="kai-bio-float-img" />

                ${String(bio.story || '')
                  .split(/\n\s*\n/)
                  .filter(Boolean)
                  .map((para) => `<p class="kai-bio-body-para">${escapeHTML(para.trim())}</p>`)
                  .join('')}

                <div class="kai-bio-credit-inline">
                  Ilustração por <strong>@kouxhii</strong>
                </div>
              </div>

              <div style="background:linear-gradient(135deg, var(--raspberry-soft), var(--balloon-blue-soft));border:1.5px solid var(--raspberry-border);border-radius:var(--radius-md);padding:1.1rem;display:flex;gap:1rem;align-items:center;margin-top:1.25rem;">
                <div aria-hidden="true" style="flex-shrink:0;"><img src="/assets/sugarcube-icon.png" alt="" style="width:48px;height:48px;object-fit:contain;" /></div>
                <div style="font-size:0.9rem;color:var(--text-espresso);">
                  <strong>Por que "Sugarcube Corner"?</strong><br/>
                  É uma homenagem direta à confeitaria mais mágica e acolhedora de Ponyville, em <em>My Little Pony</em> — um desenho que Kai adora! As cores de glacê de morango, biscoito amanteigado e os balões azuis e amarelos vêm desse universo.
                </div>
              </div>
            </div>

            <div class="detail-card" style="margin-top:1.75rem;">
              <span class="eyebrow-tag">Metodologia Transparente</span>
              <h2 class="section-title" style="margin-bottom:1rem;">Como funcionam os 4 Critérios</h2>
              <div style="display:grid;grid-template-columns:1fr;gap:1rem;">
                ${(bio.sensoryManifesto || [])
                  .map(
                    (m) => `
                  <div style="background:var(--bg-cream);border:1.5px solid var(--border-warm);border-radius:var(--radius-sm);padding:1.1rem;">
                    <h3 style="font-family:var(--font-display);font-size:1.18rem;color:var(--raspberry);margin-bottom:0.25rem;">
                      ${escapeHTML(m.criterion)} — <small style="color:var(--text-mocha);font-family:var(--font-sans);">${escapeHTML(m.summary)}</small>
                    </h3>
                    <p style="font-size:0.92rem;color:var(--text-espresso);">${escapeHTML(m.details)}</p>
                  </div>
                `
                  )
                  .join('')}
              </div>
            </div>
          </div>

          <aside>
            <div class="detail-card">
              <div style="display:flex;align-items:center;gap:0.85rem;margin-bottom:0.85rem;">
                <img src="/assets/mlp-twilight-happy.png" alt="" aria-hidden="true" class="twilight-callout-avatar" />
                <div>
                  <span class="eyebrow-tag"><img src="/assets/mlp-twilight-star.png" alt="" aria-hidden="true" class="cutie-mini-icon" /> Fórmula Oficial</span>
                  <h2 class="section-title" style="font-size:1.3rem;margin-bottom:0;">Pesos Atuais da Nota Final</h2>
                </div>
              </div>
              <p style="font-size:0.88rem;color:var(--text-muted);margin-bottom:1rem;">
                Todas as notas vão de <strong>0.0 a 10.0</strong> (aceitando meio ponto, ex: <code>8.5</code>, <code>9.5</code>) e a nota final é arredondada a 1 casa decimal:
              </p>
              <div class="mini-criteria-grid" style="margin-bottom:1.25rem;">
                <div class="mini-crit-box highlight-crit">
                  <span class="mini-crit-label">Textura</span>
                  <span class="mini-crit-val">${weights.texture}%</span>
                </div>
                <div class="mini-crit-box highlight-crit">
                  <span class="mini-crit-label">Massa</span>
                  <span class="mini-crit-val">${weights.dough}%</span>
                </div>
                <div class="mini-crit-box">
                  <span class="mini-crit-label">Sabor</span>
                  <span class="mini-crit-val">${weights.flavor}%</span>
                </div>
                <div class="mini-crit-box">
                  <span class="mini-crit-label">Recheio</span>
                  <span class="mini-crit-val">${weights.filling}%</span>
                </div>
              </div>

              <h3 style="font-family:var(--font-display);margin-bottom:0.65rem;">Régua de Notas de Kai</h3>
              <ul style="list-style:none;display:flex;flex-direction:column;gap:0.6rem;font-size:0.88rem;">
                <li style="padding:0.6rem;background:var(--raspberry-soft);border-radius:8px;">
                  <strong>9.5 a 10.0 • Antológico:</strong> Ponto de massa e textura perfeitos. Vale atravessar Feira de Santana só por essa fatia.
                </li>
                <li style="padding:0.6rem;background:var(--balloon-blue-soft);border-radius:8px;">
                  <strong>${Number(state.settings.approvalThreshold).toFixed(1)} a 9.4 • Selo Aprovado por Kai:</strong> Excelente técnica, ingredientes reais e textura ≥ ${Number(state.settings.minTextureForApproval).toFixed(1)}.
                </li>
                <li style="padding:0.6rem;background:var(--caramel-soft);border-radius:8px;">
                  <strong>7.0 a 8.4 • Bom, com ressalvas:</strong> Gostoso, mas escorregou em algum detalhe técnico.
                </li>
                <li style="padding:0.6rem;background:var(--bg-brioche);border-radius:8px;">
                  <strong>Abaixo de 7.0 • Precisa evoluir:</strong> Massa ressecada, embatumada ou uso perceptível de gordura hidrogenada/essência artificial.
                </li>
              </ul>

              <div style="margin-top:1.5rem;padding-top:1.2rem;border-top:1px solid var(--border-subtle);">
                <h3 style="font-family:var(--font-display);margin-bottom:0.4rem;">Ética & Parcerias Futuras</h3>
                <p style="font-size:0.85rem;color:var(--text-mocha);">
                  Kai paga pelas fatias avaliadas em visitas independentes. Confeitarias podem adquirir o selo visual de <em>"Vitrine Parceira"</em> para destacar seu perfil institucional, mas <strong>o código do site separa totalmente o destaque comercial do cálculo matemático das notas</strong>.
                </p>
              </div>
            </div>
          </aside>
        </div>
      </div>
    </section>
  `;
}

/* ==========================================================================
   8. PAINEL ADMINISTRATIVO PROTEGIDO (/admin)
   ========================================================================== */
async function renderAdminView() {
  updateSEOMeta({
    title: 'Painel Administrativo — Sugarcube Corner (Kai Tavares)',
    description: 'Gerenciamento seguro de confeitarias, avaliações de bolos, fotos, bio e pesos do ranking.'
  });

  if (!isAdminLoggedIn()) {
    const defaultGhRepo = detectDefaultGitHubRepo() || 'lieRp/kai_avalia';
    const isStatic = isStaticPagesMode();

    mainEl.innerHTML = `
      <section class="section-block">
        <div class="container" style="max-width:440px;">
          <div class="detail-card admin-auth-card">
            <div style="text-align:center;margin-bottom:1.35rem;">
              <span class="eyebrow-tag" style="justify-content:center;">
                <img src="/assets/sugarcube-icon.png" alt="" class="cutie-mini-icon" /> Acesso Restrito
              </span>
              <h1 class="section-title" style="font-size:1.65rem;margin-bottom:0.35rem;">Painel de Kai</h1>
              <p style="font-size:0.88rem;color:var(--text-mocha);margin:0 auto;max-width:320px;">
                Informe suas credenciais para gerenciar o guia e publicar novas avaliações.
              </p>
            </div>

            <form id="admin-unified-login-form" style="display:flex;flex-direction:column;gap:1rem;">
              <div class="form-group">
                <label class="form-label" for="adm-login-user">Usuário</label>
                <input
                  type="text"
                  id="adm-login-user"
                  class="form-input"
                  required
                  autocomplete="username"
                  placeholder="Nome de usuário"
                  value="${escapeHTML(defaultGhRepo)}"
                />
              </div>
              <div class="form-group">
                <label class="form-label" for="adm-login-pass">Senha</label>
                <input
                  type="password"
                  id="adm-login-pass"
                  class="form-input"
                  required
                  autocomplete="current-password"
                  placeholder="••••••••••••••••"
                />
              </div>
              <button type="submit" class="btn btn-primary btn-full" style="padding:0.75rem 1rem;font-size:0.95rem;margin-top:0.25rem;">
                Entrar no Painel
              </button>
            </form>
          </div>
        </div>
      </section>
    `;

    document.getElementById('admin-unified-login-form')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const u = document.getElementById('adm-login-user').value.trim();
      const p = document.getElementById('adm-login-pass').value.trim();
      const btn = e.target.querySelector('button[type="submit"]');
      if (btn) {
        btn.disabled = true;
        btn.textContent = 'Verificando...';
      }

      try {
        showToast('Verificando credenciais...');
        if (!isStatic && !p.startsWith('ghp_') && !p.startsWith('github_pat_')) {
          try {
            await loginAdmin(u, p);
            updateHeaderAdminStatus();
            showToast('Que bom ter você de volta, Kai!');
            renderAdminView();
            return;
          } catch (_) {
            // Continua para autenticação direta caso a senha não seja a local
          }
        }

        await loginAdminWithGitHub(u, p);
        updateHeaderAdminStatus();
        showToast('Que bom ter você de volta, Kai!');
        renderAdminView();
      } catch (err) {
        showToast(err.message || 'Usuário ou senha incorretos.', true);
      } finally {
        if (btn) {
          btn.disabled = false;
          btn.textContent = 'Entrar no Painel';
        }
      }
    });

    return;
  }
  }

  if (uiState.adminTab === 'community') {
    try {
      uiState.adminSuggestions = await fetchAdminSuggestions();
    } catch (err) {
      showToast(err.message, true);
    }
  }

  const state = getState();
  const cakes = getEnrichedCakes();
  const bakeries = getEnrichedBakeries();
  const editingCake = uiState.editingCakeId
    ? state.cakes.find((c) => c.id === uiState.editingCakeId)
    : null;
  const editingBakery = uiState.editingBakeryId
    ? state.bakeries.find((b) => b.id === uiState.editingBakeryId)
    : null;

  mainEl.innerHTML = `
    <section class="section-block">
      <div class="container">
        <div class="admin-header-bar">
          <div>
            <span style="font-size:0.75rem;color:#FFE066;text-transform:uppercase;font-weight:700;">Painel Editorial Seguro</span>
            <h1 style="font-family:var(--font-display);font-size:1.55rem;"><span aria-hidden="true"><img src="/assets/sugarcube-icon.png" alt="" class="site-cupcake-inline" style="margin-right:0.35rem;" /></span>Estúdio de Kai Tavares • Feira de Santana</h1>
          </div>
          <div style="display:flex;gap:0.6rem;flex-wrap:wrap;">
            <button type="button" class="btn btn-secondary btn-sm" id="export-json-btn">Baixar Backup Completo</button>
            <button type="button" class="btn btn-caramel btn-sm" id="logout-admin-btn">Encerrar Sessão</button>
          </div>
        </div>

        <div class="admin-tabs">
          <button type="button" class="admin-tab-btn ${uiState.adminTab === 'cakes' ? 'active' : ''}" data-adm-tab="cakes">
            Avaliar / Editar Bolos (${cakes.length})
          </button>
          <button type="button" class="admin-tab-btn ${uiState.adminTab === 'bakeries' ? 'active' : ''}" data-adm-tab="bakeries">
            Confeitarias (${bakeries.length})
          </button>
          <button type="button" class="admin-tab-btn ${uiState.adminTab === 'settings' ? 'active' : ''}" data-adm-tab="settings">
            Pesos, Bio de Kai & Senha
          </button>
          <button type="button" class="admin-tab-btn ${uiState.adminTab === 'community' ? 'active' : ''}" data-adm-tab="community">
            Sugestões & "Em Breve"
          </button>
        </div>

        ${
          uiState.adminTab === 'cakes'
            ? renderAdminCakesTab(state, cakes, editingCake)
            : uiState.adminTab === 'bakeries'
            ? renderAdminBakeriesTab(state, bakeries, editingBakery)
            : uiState.adminTab === 'settings'
            ? renderAdminSettingsTab(state)
            : renderAdminCommunityTab(state)
        }
      </div>
    </section>
  `;

  bindAdminEvents();
}

function renderAdminCakesTab(state, cakes, editingCake) {
  if (state.bakeries.length === 0) {
    return `
      <div class="detail-card" style="text-align:center;padding:2.5rem 1.5rem;">
        <h2 style="font-family:var(--font-display);margin-bottom:0.5rem;">Cadastre primeiro uma Confeitaria!</h2>
        <p style="color:var(--text-muted);margin-bottom:1.2rem;">
          Para publicar uma avaliação de bolo, é necessário ter pelo menos uma confeitaria real cadastrada em Feira de Santana.
        </p>
        <button type="button" class="btn btn-primary" id="go-to-bakeries-tab">Ir para a Aba Confeitarias →</button>
      </div>
    `;
  }

  const savedDraft = !editingCake ? loadCakeDraft() : null;
  const source = editingCake || savedDraft || {};

  const defaultBakeryId = source.bakeryId || state.bakeries[0]?.id || '';
  const sFlavor = source.scoreFlavor ?? 9.0;
  const sDough = source.scoreDough ?? 9.0;
  const sTexture = source.scoreTexture ?? 9.0;
  const sFilling = source.scoreFilling ?? 9.0;

  const previewFinal = computeCakeFinalScore({
    scoreFlavor: sFlavor,
    scoreDough: sDough,
    scoreTexture: sTexture,
    scoreFilling: sFilling
  });

  return `
    <div class="review-detail-grid">
      <div class="detail-card">
        <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:0.5rem;margin-bottom:1rem;">
          <div>
            <h2 style="font-family:var(--font-display);font-size:1.35rem;">
              ${editingCake ? `Editando: ${escapeHTML(editingCake.name)}` : 'Nova Avaliação de Bolo'}
            </h2>
            <small id="draft-status-indicator" style="color:var(--text-muted);">
              ${savedDraft && !editingCake ? '💾 Rascunho recuperado automaticamente' : 'Rascunho salvo automaticamente enquanto você digita'}
            </small>
          </div>
          <div style="display:flex;gap:0.4rem;">
            ${
              editingCake
                ? `<button type="button" class="btn btn-secondary btn-sm" id="cancel-edit-cake">Cancelar Edição</button>`
                : savedDraft
                ? `<button type="button" class="btn btn-secondary btn-sm" id="clear-draft-cake">Limpar Rascunho</button>`
                : ''
            }
          </div>
        </div>

        <form id="admin-cake-form" style="display:flex;flex-direction:column;gap:0.95rem;">
          <input type="hidden" id="c-id" value="${escapeHTML(editingCake?.id || '')}" />

          <div class="form-group">
            <label class="form-label" for="c-bakery">Confeitaria *</label>
            <select id="c-bakery" class="form-select" required>
              ${state.bakeries
                .map(
                  (b) =>
                    `<option value="${escapeHTML(b.id)}" ${b.id === defaultBakeryId ? 'selected' : ''}>${escapeHTML(b.name)} (${escapeHTML(b.neighborhood)})</option>`
                )
                .join('')}
            </select>
          </div>

          <div class="form-group">
            <label class="form-label" for="c-name">Nome do Bolo / Fatia *</label>
            <input type="text" id="c-name" class="form-input" required placeholder="Ex: Fatia Red Velvet com Cream Cheese" value="${escapeHTML(source.name || '')}" />
          </div>

          <div style="display:grid;grid-template-columns:1fr 1fr;gap:0.75rem;">
            <div class="form-group">
              <label class="form-label" for="c-category">Categoria / Formato</label>
              <input type="text" id="c-category" class="form-input" list="category-presets" value="${escapeHTML(source.category || 'Fatia de Vitrine')}" />
              <datalist id="category-presets">
                <option value="Fatia de Vitrine"></option>
                <option value="Bolo de Pote"></option>
                <option value="Bolo de Aniversário"></option>
                <option value="Bolo Caseiro / Vulcão"></option>
                <option value="Torta / Fatia"></option>
                <option value="Bolo Gelado / Embrulhado"></option>
              </datalist>
            </div>
            <div class="form-group">
              <label class="form-label" for="c-flavor">Família de Sabor</label>
              <input type="text" id="c-flavor" class="form-input" placeholder="Ex: Pistache & Frutas Vermelhas" value="${escapeHTML(source.flavorType || '')}" />
            </div>
          </div>

          <div style="background:var(--raspberry-soft);padding:1rem;border-radius:var(--radius-md);border:1.5px solid var(--raspberry-border);">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.75rem;">
              <strong style="font-size:0.92rem;">Notas de 0 a 10 (de 0.5 em 0.5)</strong>
              <span class="kai-seal" id="live-score-preview">Nota Final: ${previewFinal.toFixed(1)}</span>
            </div>

            <div style="display:grid;grid-template-columns:1fr 1fr;gap:0.75rem;">
              <div class="slider-score-group">
                <div class="slider-score-header">
                  <label for="c-score-texture"><strong>Textura</strong></label>
                  <span class="slider-score-val" id="val-texture">${Number(sTexture).toFixed(1)}</span>
                </div>
                <input type="range" id="c-score-texture" min="0" max="10" step="0.5" value="${sTexture}" class="score-range js-cake-slider" />
              </div>

              <div class="slider-score-group">
                <div class="slider-score-header">
                  <label for="c-score-dough"><strong>Massa</strong></label>
                  <span class="slider-score-val" id="val-dough">${Number(sDough).toFixed(1)}</span>
                </div>
                <input type="range" id="c-score-dough" min="0" max="10" step="0.5" value="${sDough}" class="score-range js-cake-slider" />
              </div>

              <div class="slider-score-group">
                <div class="slider-score-header">
                  <label for="c-score-flavor"><strong>Sabor</strong></label>
                  <span class="slider-score-val" id="val-flavor">${Number(sFlavor).toFixed(1)}</span>
                </div>
                <input type="range" id="c-score-flavor" min="0" max="10" step="0.5" value="${sFlavor}" class="score-range js-cake-slider" />
              </div>

              <div class="slider-score-group">
                <div class="slider-score-header">
                  <label for="c-score-filling"><strong>Recheio</strong></label>
                  <span class="slider-score-val" id="val-filling">${Number(sFilling).toFixed(1)}</span>
                </div>
                <input type="range" id="c-score-filling" min="0" max="10" step="0.5" value="${sFilling}" class="score-range js-cake-slider" />
              </div>
            </div>
          </div>

          <div class="form-group">
            <label class="form-label" for="c-verdict">Veredito Sincero de Kai *</label>
            <textarea id="c-verdict" rows="4" class="form-textarea" required placeholder="Descreva o ponto da massa, a textura do creme, o equilíbrio do açúcar...">${escapeHTML(source.kaiVerdict || '')}</textarea>
          </div>

          <div style="display:grid;grid-template-columns:1fr 1fr;gap:0.75rem;">
            <div class="form-group">
              <label class="form-label" for="c-crumb">Ponto da Massa (Raio-X)</label>
              <input type="text" id="c-crumb" class="form-input" placeholder="Ex: Alveolado macio e úmido" value="${escapeHTML(source.sensoryNotes?.crumbPoint || '')}" />
            </div>
            <div class="form-group">
              <label class="form-label" for="c-mouthfeel">Sensação na Boca / Textura</label>
              <input type="text" id="c-mouthfeel" class="form-input" placeholder="Ex: Creme aveludado sem grumos" value="${escapeHTML(source.sensoryNotes?.mouthfeel || '')}" />
            </div>
            <div class="form-group">
              <label class="form-label" for="c-moisture">Umidade</label>
              <input type="text" id="c-moisture" class="form-input" placeholder="Ex: Molhadinho sem desmanchar" value="${escapeHTML(source.sensoryNotes?.moisture || '')}" />
            </div>
            <div class="form-group">
              <label class="form-label" for="c-sweetness">Nível de Dulçor</label>
              <input type="text" id="c-sweetness" class="form-input" placeholder="Ex: Equilibrado pela fruta" value="${escapeHTML(source.sensoryNotes?.sweetness || '')}" />
            </div>
          </div>

          <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:0.75rem;">
            <div class="form-group">
              <label class="form-label" for="c-price">Preço Aprox. (R$)</label>
              <input type="number" step="0.50" id="c-price" class="form-input" value="${source.approxPrice ?? 22}" />
            </div>
            <div class="form-group">
              <label class="form-label" for="c-date">Data da Visita</label>
              <input type="date" id="c-date" class="form-input" value="${source.visitedAt || new Date().toISOString().slice(0, 10)}" />
            </div>
            <div class="form-group">
              <label class="form-label" for="c-year">Edição Anual</label>
              <input type="number" id="c-year" class="form-input" value="${source.editionYear || 2026}" />
            </div>
          </div>

          <div style="display:grid;grid-template-columns:1fr 2fr;gap:0.75rem;">
            <div class="form-group">
              <label class="form-label" for="c-reeval-date">Reavaliado em (opcional)</label>
              <input type="date" id="c-reeval-date" class="form-input" value="${source.reevaluatedAt || ''}" />
            </div>
            <div class="form-group">
              <label class="form-label" for="c-reeval-note">Nota da Reavaliação</label>
              <input type="text" id="c-reeval-note" class="form-input" placeholder="Ex: Nova visita após 2 meses e a massa subiu de nota!" value="${escapeHTML(source.reevaluationNote || '')}" />
            </div>
          </div>

          <div class="form-group">
            <label class="form-label" for="c-photo-file">Fotos Reais do Bolo (Upload do Celular/PC)</label>
            <input type="file" id="c-photo-file" accept="image/jpeg,image/png,image/webp" class="form-input" />
            <small style="color:var(--text-muted);font-size:0.76rem;">A imagem é otimizada no navegador e validada no servidor antes de salvar.</small>
            <input type="text" id="c-photo-url" class="form-input" placeholder="Caminho da foto enviada (/uploads/...)" value="${escapeHTML(source.photos?.[0] || '')}" style="margin-top:0.35rem;" />
          </div>

          <div style="display:flex;gap:0.65rem;flex-wrap:wrap;">
            <button type="button" class="btn btn-caramel" id="preview-admin-story-btn">
              Pré-visualizar Card de Story (9:16)
            </button>
            <button type="submit" class="btn btn-primary" style="flex:1;">
              ${editingCake ? 'Salvar Alterações da Avaliação' : 'Publicar Avaliação no Ranking'}
            </button>
          </div>
        </form>
      </div>

      <div>
        <h3 style="font-family:var(--font-display);font-size:1.25rem;margin-bottom:0.85rem;">
          Avaliações Publicadas (${cakes.length})
        </h3>
        <div style="display:flex;flex-direction:column;gap:0.75rem;">
          ${
            cakes.length === 0
              ? `<p style="color:var(--text-muted);">Nenhum bolo publicado ainda.</p>`
              : cakes
                  .map(
                    (c) => `
                  <div class="detail-card" style="padding:1rem;display:flex;justify-content:space-between;align-items:center;gap:0.75rem;">
                    <div style="display:flex;gap:0.75rem;align-items:center;">
                      <img src="${escapeHTML(c.photos?.[0] || '/assets/og-sugarcube.svg')}" alt="Foto de ${escapeHTML(c.name)}" style="width:60px;height:60px;border-radius:10px;object-fit:cover;flex-shrink:0;" />
                      <div>
                        <strong style="font-size:0.95rem;display:block;">${escapeHTML(c.name)}</strong>
                        <small style="color:var(--text-muted);">${escapeHTML(c.bakery?.name)} • Nota <strong>${c.finalScore.toFixed(1)}</strong> (Tex: ${c.scoreTexture.toFixed(1)} | Mas: ${c.scoreDough.toFixed(1)})</small>
                      </div>
                    </div>
                    <div style="display:flex;gap:0.4rem;">
                      <button type="button" class="btn btn-secondary btn-sm js-edit-cake" data-id="${escapeHTML(c.id)}">Editar</button>
                      <button type="button" class="btn btn-caramel btn-sm js-del-cake" data-id="${escapeHTML(c.id)}" data-name="${escapeHTML(c.name)}">Excluir</button>
                    </div>
                  </div>
                `
                  )
                  .join('')
          }
        </div>
      </div>
    </div>
  `;
}

function renderAdminBakeriesTab(state, bakeries, editingBakery) {
  return `
    <div class="review-detail-grid">
      <div class="detail-card">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1rem;">
          <h2 style="font-family:var(--font-display);font-size:1.35rem;">
            ${editingBakery ? `Editando: ${escapeHTML(editingBakery.name)}` : 'Cadastrar Confeitaria em Feira'}
          </h2>
          ${
            editingBakery
              ? `<button type="button" class="btn btn-secondary btn-sm" id="cancel-edit-bakery">Cancelar</button>`
              : ''
          }
        </div>

        <form id="admin-bakery-form" style="display:flex;flex-direction:column;gap:0.9rem;">
          <input type="hidden" id="b-id" value="${escapeHTML(editingBakery?.id || '')}" />

          <div class="form-group">
            <label class="form-label" for="b-name">Nome da Confeitaria *</label>
            <input type="text" id="b-name" class="form-input" required value="${escapeHTML(editingBakery?.name || '')}" placeholder="Nome real da confeitaria" />
          </div>

          <div style="display:grid;grid-template-columns:1fr 1fr;gap:0.75rem;">
            <div class="form-group">
              <label class="form-label" for="b-neighborhood">Bairro (Feira de Santana) *</label>
              <input type="text" id="b-neighborhood" class="form-input" required list="fsa-neighborhoods" value="${escapeHTML(editingBakery?.neighborhood || '')}" placeholder="Ex: Kalilândia" />
              <datalist id="fsa-neighborhoods">
                <option value="Kalilândia"></option>
                <option value="Santa Mônica"></option>
                <option value="São João"></option>
                <option value="Capuchinhos"></option>
                <option value="SIM"></option>
                <option value="Centro"></option>
                <option value="Cidade Nova"></option>
                <option value="Getúlio Vargas"></option>
                <option value="Brasília"></option>
              </datalist>
            </div>

            <div class="form-group">
              <label class="form-label" for="b-price">Faixa de Preço</label>
              <select id="b-price" class="form-select">
                <option value="$" ${editingBakery?.priceRange === '$' ? 'selected' : ''}>$ (Econômico)</option>
                <option value="$$" ${!editingBakery || editingBakery?.priceRange === '$$' ? 'selected' : ''}>$$ (Moderado)</option>
                <option value="$$$" ${editingBakery?.priceRange === '$$$' ? 'selected' : ''}>$$$ (Premium)</option>
              </select>
            </div>
          </div>

          <div class="form-group">
            <label class="form-label" for="b-address">Endereço Completo *</label>
            <input type="text" id="b-address" class="form-input" required value="${escapeHTML(editingBakery?.address || '')}" placeholder="Rua / Avenida, número - Bairro, Feira de Santana - BA" />
          </div>

          <div style="display:grid;grid-template-columns:1fr 1fr;gap:0.75rem;">
            <div class="form-group">
              <label class="form-label" for="b-insta">Instagram</label>
              <input type="text" id="b-insta" class="form-input" value="${escapeHTML(editingBakery?.instagram || '')}" placeholder="@confeitaria" />
            </div>
            <div class="form-group">
              <label class="form-label" for="b-whats">WhatsApp (somente números com DDI+DDD, opcional)</label>
              <input type="text" id="b-whats" class="form-input" value="${escapeHTML(editingBakery?.whatsapp || '')}" placeholder="Ex: 55759..." />
            </div>
          </div>

          <div class="form-group">
            <label class="form-label" for="b-hours">Horário de Funcionamento</label>
            <input type="text" id="b-hours" class="form-input" value="${escapeHTML(editingBakery?.openingHours || '')}" placeholder="Ex: Ter a Dom: 13h às 20h" />
          </div>

          <div style="display:grid;grid-template-columns:1fr 1fr;gap:0.75rem;">
            <div class="form-group">
              <label class="form-label" for="b-lat">Latitude (Mapa Feira)</label>
              <input type="number" step="0.0001" id="b-lat" class="form-input" value="${editingBakery?.lat ?? -12.2545}" />
            </div>
            <div class="form-group">
              <label class="form-label" for="b-lng">Longitude (Mapa Feira)</label>
              <input type="number" step="0.0001" id="b-lng" class="form-input" value="${editingBakery?.lng ?? -38.955}" />
            </div>
          </div>

          <div class="form-group">
            <label class="form-label" for="b-photo-file">Foto de Capa da Confeitaria</label>
            <input type="file" id="b-photo-file" accept="image/jpeg,image/png,image/webp" class="form-input" />
            <input type="text" id="b-photo-url" class="form-input" value="${escapeHTML(editingBakery?.coverPhoto || '')}" placeholder="Caminho da foto de capa" style="margin-top:0.35rem;" />
          </div>

          <div class="form-group">
            <label class="form-label" for="b-desc">Descrição da Casa por Kai *</label>
            <textarea id="b-desc" rows="3" class="form-textarea" required>${escapeHTML(editingBakery?.description || '')}</textarea>
          </div>

          <label class="toggle-check">
            <input type="checkbox" id="b-partner" ${editingBakery?.isFeaturedPartner ? 'checked' : ''} />
            <span>Marcar como "Vitrine Parceira" (exibe aviso ético sem alterar notas)</span>
          </label>

          <button type="submit" class="btn btn-primary btn-full">
            ${editingBakery ? 'Atualizar Confeitaria' : 'Salvar Nova Confeitaria'}
          </button>
        </form>
      </div>

      <div>
        <h3 style="font-family:var(--font-display);font-size:1.25rem;margin-bottom:0.85rem;">
          Confeitarias Cadastradas (${bakeries.length})
        </h3>
        <div style="display:flex;flex-direction:column;gap:0.75rem;">
          ${
            bakeries.length === 0
              ? `<p style="color:var(--text-muted);">Nenhuma confeitaria cadastrada ainda.</p>`
              : bakeries
                  .map(
                    (b) => `
                  <div class="detail-card" style="padding:1rem;display:flex;justify-content:space-between;align-items:center;gap:0.75rem;">
                    <div>
                      <strong style="font-size:0.98rem;">${escapeHTML(b.name)}</strong>
                      <span class="neighborhood-tag" style="margin-left:0.4rem;">${escapeHTML(b.neighborhood)}</span>
                      <small style="display:block;color:var(--text-muted);margin-top:0.2rem;">
                        Média: <strong>${b.overallScore.toFixed(1)}</strong> (${b.cakesCount} bolo(s) avaliado(s))
                      </small>
                    </div>
                    <div style="display:flex;gap:0.4rem;">
                      <button type="button" class="btn btn-secondary btn-sm js-edit-bakery" data-id="${escapeHTML(b.id)}">Editar</button>
                      <button type="button" class="btn btn-caramel btn-sm js-del-bakery" data-id="${escapeHTML(b.id)}" data-name="${escapeHTML(b.name)}">Excluir</button>
                    </div>
                  </div>
                `
                  )
                  .join('')
          }
        </div>
      </div>
    </div>
  `;
}

function renderAdminSettingsTab(state) {
  const w = state.settings.weights || { flavor: 25, dough: 25, texture: 25, filling: 25 };
  const bio = state.settings.kaiBio || {};
  return `
    <div class="review-detail-grid">
      <div class="detail-card">
        <h2 style="font-family:var(--font-display);font-size:1.35rem;margin-bottom:0.4rem;">
          Pesos da Média, Selo & Bio Pública de Kai
        </h2>
        <div class="kai-sensory-callout" style="margin-bottom:1rem;">
          <strong>Importante para Kai:</strong> Revise abaixo o texto da sua Bio (página <em>Sobre Kai</em>) para garantir que cada palavra publicada reflete exatamente como você deseja se apresentar ao público.
        </div>

        <form id="admin-settings-form" style="display:flex;flex-direction:column;gap:1rem;">
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:0.85rem;">
            <div class="form-group">
              <label class="form-label" for="s-w-texture">Peso de Textura (%)</label>
              <input type="number" id="s-w-texture" class="form-input" value="${w.texture}" min="0" max="100" />
            </div>
            <div class="form-group">
              <label class="form-label" for="s-w-dough">Peso de Massa (%)</label>
              <input type="number" id="s-w-dough" class="form-input" value="${w.dough}" min="0" max="100" />
            </div>
            <div class="form-group">
              <label class="form-label" for="s-w-flavor">Peso de Sabor (%)</label>
              <input type="number" id="s-w-flavor" class="form-input" value="${w.flavor}" min="0" max="100" />
            </div>
            <div class="form-group">
              <label class="form-label" for="s-w-filling">Peso de Recheio (%)</label>
              <input type="number" id="s-w-filling" class="form-input" value="${w.filling}" min="0" max="100" />
            </div>
          </div>

          <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:0.75rem;">
            <div class="form-group">
              <label class="form-label" for="s-threshold">Nota p/ Selo "Aprovado por Kai"</label>
              <input type="number" step="0.5" min="5" max="10" id="s-threshold" class="form-input" value="${state.settings.approvalThreshold ?? 8.5}" />
            </div>
            <div class="form-group">
              <label class="form-label" for="s-min-tex">Textura Mínima p/ Selo</label>
              <input type="number" step="0.5" min="5" max="10" id="s-min-tex" class="form-input" value="${state.settings.minTextureForApproval ?? 8.0}" />
            </div>
            <div class="form-group">
              <label class="form-label" for="s-min-cakes">Mín. Bolos p/ Ranking Casa</label>
              <input type="number" step="1" min="1" max="10" id="s-min-cakes" class="form-input" value="${state.settings.minCakesForConsolidatedRank ?? 2}" />
            </div>
          </div>

          <div class="form-group">
            <label class="form-label" for="s-bio-title">Título da Bio (Página Sobre Kai)</label>
            <input type="text" id="s-bio-title" class="form-input" value="${escapeHTML(bio.title || '')}" />
          </div>

          <div class="form-group">
            <label class="form-label" for="s-bio-lead">Subtítulo / Resumo de Kai</label>
            <input type="text" id="s-bio-lead" class="form-input" value="${escapeHTML(bio.lead || '')}" />
          </div>

          <div class="form-group">
            <label class="form-label" for="s-bio-story">História & Apresentação Pública de Kai</label>
            <textarea id="s-bio-story" rows="5" class="form-textarea">${escapeHTML(bio.story || '')}</textarea>
          </div>

          <div style="display:flex;gap:0.75rem;flex-wrap:wrap;">
            <button type="submit" class="btn btn-primary">Salvar Configurações e Bio</button>
            <button type="button" class="btn btn-secondary" id="equal-weights-btn">Restaurar Pesos Iguais (25%)</button>
          </div>
        </form>
      </div>

      <div class="detail-card">
        <h2 style="font-family:var(--font-display);font-size:1.35rem;margin-bottom:0.5rem;">
          Alterar Senha de Admin (Hash Scrypt)
        </h2>
        <p style="font-size:0.86rem;color:var(--text-muted);margin-bottom:1.1rem;">
          A senha nunca fica salva em texto puro; o servidor armazena apenas o hash criptográfico <code>scrypt</code>.
        </p>
        <form id="admin-password-form" style="display:flex;flex-direction:column;gap:0.9rem;">
          <div class="form-group">
            <label class="form-label" for="p-current">Senha Atual *</label>
            <input type="password" id="p-current" class="form-input" required autocomplete="current-password" />
          </div>
          <div class="form-group">
            <label class="form-label" for="p-new">Nova Senha (mínimo 8 caracteres) *</label>
            <input type="password" id="p-new" class="form-input" required minlength="8" autocomplete="new-password" />
          </div>
          <button type="submit" class="btn btn-primary btn-full">Atualizar Senha com Segurança</button>
        </form>
      </div>
    </div>
  `;
}

function renderAdminCommunityTab(state) {
  const suggestions = uiState.adminSuggestions || [];
  const upcoming = state.upcomingBakeries || [];

  return `
    <div class="review-detail-grid">
      <div class="detail-card">
        <h2 style="font-family:var(--font-display);font-size:1.3rem;margin-bottom:0.75rem;">
          Sugestões Enviadas pelo Público (${suggestions.length})
        </h2>
        ${
          suggestions.length === 0
            ? `<p style="color:var(--text-muted);">Nenhuma sugestão pendente de moderação.</p>`
            : `<div style="display:flex;flex-direction:column;gap:0.75rem;">
                ${suggestions
                  .map(
                    (s) => `
                  <div style="padding:0.9rem;background:var(--bg-cream);border:1px solid var(--border-warm);border-radius:var(--radius-sm);">
                    <strong>${escapeHTML(s.bakeryName)}</strong> <span class="neighborhood-tag">${escapeHTML(s.neighborhood)}</span>
                    <p style="font-size:0.88rem;margin:0.25rem 0;">Bolo sugerido: <strong>${escapeHTML(s.cakeSuggested)}</strong></p>
                    <p style="font-size:0.84rem;color:var(--text-mocha);font-style:italic;">"${escapeHTML(s.comment)}" — por ${escapeHTML(s.submittedBy)}</p>
                    <div style="display:flex;gap:0.5rem;margin-top:0.6rem;">
                      <button type="button" class="btn btn-primary btn-sm js-promote-sug" data-id="${escapeHTML(s.id)}">
                        Aprovar para Votação "Em Breve"
                      </button>
                      <button type="button" class="btn btn-secondary btn-sm js-del-sug" data-id="${escapeHTML(s.id)}">
                        Excluir
                      </button>
                    </div>
                  </div>
                `
                  )
                  .join('')}
              </div>`
        }
      </div>

      <div class="detail-card">
        <h2 style="font-family:var(--font-display);font-size:1.3rem;margin-bottom:0.75rem;">
          Adicionar à Lista "Em Breve" (${upcoming.length})
        </h2>
        <form id="admin-upcoming-form" style="display:flex;flex-direction:column;gap:0.75rem;margin-bottom:1.25rem;">
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:0.6rem;">
            <input type="text" id="up-name" class="form-input" required placeholder="Nome da confeitaria *" />
            <input type="text" id="up-neigh" class="form-input" required placeholder="Bairro em Feira *" />
          </div>
          <input type="text" id="up-spec" class="form-input" required placeholder="Qual bolo Kai vai testar lá? *" />
          <div style="display:grid;grid-template-columns:2fr 1fr;gap:0.6rem;">
            <input type="text" id="up-reason" class="form-input" placeholder="Por que está no radar?" />
            <input type="text" id="up-month" class="form-input" placeholder="Mês previsto" value="Em breve" />
          </div>
          <button type="submit" class="btn btn-primary btn-sm">Adicionar ao Radar "Em Breve"</button>
        </form>

        <div style="display:flex;flex-direction:column;gap:0.65rem;">
          ${upcoming
            .map(
              (u) => `
            <div style="padding:0.75rem;background:var(--bg-cream);border:1px solid var(--border-subtle);border-radius:8px;display:flex;justify-content:space-between;align-items:center;">
              <div>
                <strong>${escapeHTML(u.name)}</strong> (${escapeHTML(u.neighborhood)}) — <strong>${u.votes} voto(s)</strong>
                <small style="display:block;color:var(--text-muted);">${escapeHTML(u.specialty)}</small>
              </div>
              <button type="button" class="btn btn-caramel btn-sm js-del-upcoming" data-id="${escapeHTML(u.id)}" data-name="${escapeHTML(u.name)}">Remover</button>
            </div>
          `
            )
            .join('')}
        </div>
      </div>
    </div>
  `;
}

function collectCakeFormPayload() {
  const photoUrl = document.getElementById('c-photo-url')?.value.trim() || '';
  return {
    id: document.getElementById('c-id')?.value || null,
    bakeryId: document.getElementById('c-bakery')?.value || '',
    name: document.getElementById('c-name')?.value || '',
    category: document.getElementById('c-category')?.value || 'Fatia de Vitrine',
    flavorType: document.getElementById('c-flavor')?.value || '',
    scoreTexture: Number(document.getElementById('c-score-texture')?.value || 9),
    scoreDough: Number(document.getElementById('c-score-dough')?.value || 9),
    scoreFlavor: Number(document.getElementById('c-score-flavor')?.value || 9),
    scoreFilling: Number(document.getElementById('c-score-filling')?.value || 9),
    kaiVerdict: document.getElementById('c-verdict')?.value || '',
    sensoryNotes: {
      crumbPoint: document.getElementById('c-crumb')?.value || '',
      mouthfeel: document.getElementById('c-mouthfeel')?.value || '',
      moisture: document.getElementById('c-moisture')?.value || '',
      sweetness: document.getElementById('c-sweetness')?.value || ''
    },
    approxPrice: Number(document.getElementById('c-price')?.value || 0),
    visitedAt: document.getElementById('c-date')?.value || new Date().toISOString().slice(0, 10),
    editionYear: Number(document.getElementById('c-year')?.value || 2026),
    reevaluatedAt: document.getElementById('c-reeval-date')?.value || null,
    reevaluationNote: document.getElementById('c-reeval-note')?.value || '',
    photos: photoUrl ? [photoUrl] : []
  };
}

function bindAdminEvents() {
  mainEl.querySelectorAll('[data-adm-tab]').forEach((btn) => {
    btn.addEventListener('click', () => {
      uiState.adminTab = btn.getAttribute('data-adm-tab');
      renderAdminView();
    });
  });

  document.getElementById('go-to-bakeries-tab')?.addEventListener('click', () => {
    uiState.adminTab = 'bakeries';
    renderAdminView();
  });

  document.getElementById('logout-admin-btn')?.addEventListener('click', async () => {
    try {
      await logoutAdmin();
      updateHeaderAdminStatus();
      showToast('Sessão encerrada com segurança.');
      renderAdminView();
    } catch (err) {
      showToast(err.message, true);
    }
  });

  document.getElementById('export-json-btn')?.addEventListener('click', async () => {
    try {
      const backupObj = await downloadServerBackup();
      const dataStr = JSON.stringify(backupObj, null, 2);
      const blob = new Blob([dataStr], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `sugarcube-corner-backup-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      showToast('Backup JSON baixado e cópia .db criada no servidor!');
    } catch (err) {
      showToast(err.message, true);
    }
  });

  const updateLiveCakeScoreAndDraft = () => {
    const sTexture = Number(document.getElementById('c-score-texture')?.value || 0);
    const sDough = Number(document.getElementById('c-score-dough')?.value || 0);
    const sFlavor = Number(document.getElementById('c-score-flavor')?.value || 0);
    const sFilling = Number(document.getElementById('c-score-filling')?.value || 0);

    if (document.getElementById('val-texture')) {
      document.getElementById('val-texture').textContent = sTexture.toFixed(1);
      document.getElementById('val-dough').textContent = sDough.toFixed(1);
      document.getElementById('val-flavor').textContent = sFlavor.toFixed(1);
      document.getElementById('val-filling').textContent = sFilling.toFixed(1);
    }

    const finalScore = computeCakeFinalScore({
      scoreTexture: sTexture,
      scoreDough: sDough,
      scoreFlavor: sFlavor,
      scoreFilling: sFilling
    });
    const approved = isCakeApprovedByKai({ scoreTexture: sTexture }, finalScore);
    const previewEl = document.getElementById('live-score-preview');
    if (previewEl) {
      previewEl.textContent = `Nota Final: ${finalScore.toFixed(1)} ${approved ? '• 🎈 Aprovado por Kai' : ''}`;
    }

    if (!uiState.editingCakeId) {
      saveCakeDraft(collectCakeFormPayload());
      const ind = document.getElementById('draft-status-indicator');
      if (ind) ind.textContent = '💾 Rascunho salvo automaticamente';
    }
  };

  mainEl.querySelectorAll('.js-cake-slider').forEach((s) => {
    s.addEventListener('input', updateLiveCakeScoreAndDraft);
  });

  document.getElementById('admin-cake-form')?.addEventListener('input', () => {
    if (!uiState.editingCakeId) {
      saveCakeDraft(collectCakeFormPayload());
    }
  });

  document.getElementById('clear-draft-cake')?.addEventListener('click', () => {
    clearCakeDraft();
    showToast('Rascunho limpo.');
    renderAdminView();
  });

  // Pré-visualizar Card de Story 9:16 direto do formulário Admin
  document.getElementById('preview-admin-story-btn')?.addEventListener('click', async () => {
    const payload = collectCakeFormPayload();
    const state = getState();
    const bakery = state.bakeries.find((b) => b.id === payload.bakeryId) || {
      name: 'Confeitaria',
      neighborhood: 'Feira de Santana'
    };
    const finalScore = computeCakeFinalScore(payload);
    const kaiApproved = isCakeApprovedByKai(payload, finalScore);

    await openStoryModalWithCakeObject({
      ...payload,
      name: payload.name || 'Prévia do Bolo',
      kaiVerdict: payload.kaiVerdict || 'Prévia do veredito sensorial de Kai Tavares...',
      finalScore,
      kaiApproved,
      bakery
    });
  });

  document.getElementById('c-photo-file')?.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      showToast('Otimizando e enviando imagem...');
      const url = await optimizeAndUploadImage(file);
      document.getElementById('c-photo-url').value = url;
      updateLiveCakeScoreAndDraft();
      showToast('Foto otimizada e salva no servidor!');
    } catch (err) {
      showToast(err.message, true);
    }
  });

  document.getElementById('b-photo-file')?.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      showToast('Otimizando foto de capa...');
      const url = await optimizeAndUploadImage(file);
      document.getElementById('b-photo-url').value = url;
      showToast('Foto de capa salva com sucesso!');
    } catch (err) {
      showToast(err.message, true);
    }
  });

  document.getElementById('admin-cake-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await saveCake(collectCakeFormPayload());
      uiState.editingCakeId = null;
      showToast('Avaliação publicada com sucesso!');
      renderAdminView();
    } catch (err) {
      showToast(err.message, true);
    }
  });

  document.getElementById('cancel-edit-cake')?.addEventListener('click', () => {
    uiState.editingCakeId = null;
    renderAdminView();
  });

  mainEl.querySelectorAll('.js-edit-cake').forEach((btn) => {
    btn.addEventListener('click', () => {
      uiState.editingCakeId = btn.getAttribute('data-id');
      renderAdminView();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  });

  mainEl.querySelectorAll('.js-del-cake').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const name = btn.getAttribute('data-name') || 'este bolo';
      if (!window.confirm(`Tem certeza que deseja excluir a avaliação "${name}"? Um backup automático do banco será criado antes.`)) {
        return;
      }
      try {
        await deleteCake(btn.getAttribute('data-id'));
        showToast('Avaliação removida.');
        renderAdminView();
      } catch (err) {
        showToast(err.message, true);
      }
    });
  });

  document.getElementById('admin-bakery-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await saveBakery({
        id: document.getElementById('b-id').value || null,
        name: document.getElementById('b-name').value,
        neighborhood: document.getElementById('b-neighborhood').value,
        priceRange: document.getElementById('b-price').value,
        address: document.getElementById('b-address').value,
        instagram: document.getElementById('b-insta').value,
        whatsapp: document.getElementById('b-whats').value,
        openingHours: document.getElementById('b-hours').value,
        lat: document.getElementById('b-lat').value,
        lng: document.getElementById('b-lng').value,
        coverPhoto: document.getElementById('b-photo-url').value,
        description: document.getElementById('b-desc').value,
        isFeaturedPartner: document.getElementById('b-partner').checked
      });
      uiState.editingBakeryId = null;
      showToast('Confeitaria salva com sucesso!');
      renderAdminView();
    } catch (err) {
      showToast(err.message, true);
    }
  });

  document.getElementById('cancel-edit-bakery')?.addEventListener('click', () => {
    uiState.editingBakeryId = null;
    renderAdminView();
  });

  mainEl.querySelectorAll('.js-edit-bakery').forEach((btn) => {
    btn.addEventListener('click', () => {
      uiState.editingBakeryId = btn.getAttribute('data-id');
      renderAdminView();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  });

  mainEl.querySelectorAll('.js-del-bakery').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const name = btn.getAttribute('data-name') || 'esta confeitaria';
      if (!window.confirm(`Tem certeza que deseja excluir a confeitaria "${name}" e todos os bolos vinculados a ela?`)) {
        return;
      }
      try {
        await deleteBakery(btn.getAttribute('data-id'));
        showToast('Confeitaria excluída.');
        renderAdminView();
      } catch (err) {
        showToast(err.message, true);
      }
    });
  });

  document.getElementById('admin-settings-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await saveSettings({
        weights: {
          texture: Number(document.getElementById('s-w-texture').value) || 25,
          dough: Number(document.getElementById('s-w-dough').value) || 25,
          flavor: Number(document.getElementById('s-w-flavor').value) || 25,
          filling: Number(document.getElementById('s-w-filling').value) || 25
        },
        approvalThreshold: Number(document.getElementById('s-threshold').value) || 8.5,
        minTextureForApproval: Number(document.getElementById('s-min-tex').value) || 8.0,
        minCakesForConsolidatedRank: Number(document.getElementById('s-min-cakes').value) || 2,
        kaiBio: {
          title: document.getElementById('s-bio-title').value,
          lead: document.getElementById('s-bio-lead').value,
          story: document.getElementById('s-bio-story').value
        }
      });
      showToast('Pesos e Bio de Kai atualizados com sucesso!');
      renderAdminView();
    } catch (err) {
      showToast(err.message, true);
    }
  });

  document.getElementById('equal-weights-btn')?.addEventListener('click', () => {
    document.getElementById('s-w-texture').value = 25;
    document.getElementById('s-w-dough').value = 25;
    document.getElementById('s-w-flavor').value = 25;
    document.getElementById('s-w-filling').value = 25;
  });

  document.getElementById('admin-password-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const cur = document.getElementById('p-current').value;
      const nw = document.getElementById('p-new').value;
      await changeAdminPassword(cur, nw);
      e.target.reset();
      showToast('Senha atualizada com sucesso!');
    } catch (err) {
      showToast(err.message, true);
    }
  });

  document.getElementById('admin-upcoming-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await addUpcomingBakery({
        name: document.getElementById('up-name').value,
        neighborhood: document.getElementById('up-neigh').value,
        specialty: document.getElementById('up-spec').value,
        reason: document.getElementById('up-reason').value,
        plannedMonth: document.getElementById('up-month').value
      });
      showToast('Confeitaria adicionada à lista Em Breve!');
      renderAdminView();
    } catch (err) {
      showToast(err.message, true);
    }
  });

  mainEl.querySelectorAll('.js-promote-sug').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        await promoteSuggestionToUpcoming(btn.getAttribute('data-id'));
        showToast('Sugestão aprovada para a votação "Em Breve"!');
        renderAdminView();
      } catch (err) {
        showToast(err.message, true);
      }
    });
  });

  mainEl.querySelectorAll('.js-del-sug').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!window.confirm('Deseja realmente excluir esta sugestão?')) return;
      try {
        await deleteSuggestion(btn.getAttribute('data-id'));
        showToast('Sugestão removida.');
        renderAdminView();
      } catch (err) {
        showToast(err.message, true);
      }
    });
  });

  mainEl.querySelectorAll('.js-del-upcoming').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const name = btn.getAttribute('data-name') || 'este item';
      if (!window.confirm(`Remover "${name}" da lista Em Breve?`)) return;
      try {
        await deleteUpcomingBakery(btn.getAttribute('data-id'));
        showToast('Item removido da lista Em Breve.');
        renderAdminView();
      } catch (err) {
        showToast(err.message, true);
      }
    });
  });

  applySubpathFixes(mainEl);
}

function bindStoryButtons() {
  mainEl.querySelectorAll('.js-open-story').forEach((btn) => {
    btn.addEventListener('click', () => {
      openStoryModal(btn.getAttribute('data-cake-id'));
    });
  });
}

/* ==========================================================================
   ROTEADOR SPA (HISTORY API COM SUPORTE A LEGADO #/)
   ========================================================================== */
function parseCurrentLocation() {
  if (window.location.hash && window.location.hash.startsWith('#/')) {
    const cleanTarget = resolveSitePath(window.location.hash.slice(1));
    window.history.replaceState({}, '', cleanTarget);
  }

  let path = window.location.pathname || '/';
  if (SITE_BASE_PATH && path.startsWith(SITE_BASE_PATH)) {
    path = path.slice(SITE_BASE_PATH.length) || '/';
  }
  path = path.replace(/\/index\.html$/i, '') || '/';
  if (path.length > 1 && path.endsWith('/')) {
    path = path.slice(0, -1);
  }

  const queryParams = {};
  const usp = new URLSearchParams(window.location.search);
  usp.forEach((v, k) => {
    queryParams[k] = v;
  });
  return { path, queryParams };
}

function highlightActiveNav(path) {
  let routeKey = 'home';
  if (path.startsWith('/ranking')) routeKey = 'ranking';
  else if (path.startsWith('/mapa')) routeKey = 'mapa';
  else if (path.startsWith('/em-breve')) routeKey = 'em-breve';
  else if (path.startsWith('/sobre')) routeKey = 'sobre';
  else if (path.startsWith('/admin')) routeKey = 'admin';

  document.querySelectorAll('[data-route]').forEach((el) => {
    if (el.getAttribute('data-route') === routeKey) {
      el.classList.add('active');
    } else {
      el.classList.remove('active');
    }
  });
}

function handleRouteChange() {
  const { path, queryParams } = parseCurrentLocation();
  highlightActiveNav(path);
  updateHeaderAdminStatus();

  if (path === '/' || path === '') {
    renderHomeView();
  } else if (path === '/ranking') {
    renderRankingView(queryParams);
  } else if (path.startsWith('/confeitaria/')) {
    const slug = decodeURIComponent(path.replace('/confeitaria/', '').replace(/\/$/, ''));
    renderBakeryDetailView(slug);
  } else if (path.startsWith('/bolo/')) {
    const slug = decodeURIComponent(path.replace('/bolo/', '').replace(/\/$/, ''));
    renderCakeDetailView(slug);
  } else if (path === '/mapa') {
    renderMapView();
  } else if (path === '/em-breve') {
    renderUpcomingView();
  } else if (path === '/sobre') {
    renderAboutView();
  } else if (path === '/admin') {
    renderAdminView();
  } else {
    renderHomeView();
  }

  applySubpathFixes(document.body);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function setupGlobalLinkInterceptor() {
  document.addEventListener('click', (e) => {
    const anchor = e.target.closest('a');
    if (!anchor) return;
    if (anchor.target === '_blank' || anchor.hasAttribute('download')) return;
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;

    const href = anchor.getAttribute('href');
    if (!href || href.startsWith('http') || href.startsWith('mailto:') || href.startsWith('tel:')) {
      return;
    }
    if (href.endsWith('/sitemap.xml') || href.endsWith('/robots.txt')) return;

    if (href.startsWith('/')) {
      e.preventDefault();
      let cleanRoute = href;
      if (SITE_BASE_PATH && cleanRoute.startsWith(SITE_BASE_PATH)) {
        cleanRoute = cleanRoute.slice(SITE_BASE_PATH.length) || '/';
      }
      navigateTo(cleanRoute);
    }
  });
}

async function bootstrap() {
  try {
    await initStore();
  } catch (err) {
    showToast(err.message, true);
  }
  setupStoryModalEvents();
  setupGlobalLinkInterceptor();
  window.addEventListener('popstate', handleRouteChange);
  handleRouteChange();
}

bootstrap();
