/**
 * Sugarcube Corner — Visualização de Notas (Gráfico Radar SVG & Barras Sensoriais)
 * Paleta Sugarcube Corner (Ponyville Patisserie) com acessibilidade (aria-hidden nos emojis).
 */

export function renderRadarChartSVG(scores, size = 270) {
  const sFlavor = Number(scores.flavor || scores.scoreFlavor || 0);
  const sDough = Number(scores.dough || scores.scoreDough || 0);
  const sTexture = Number(scores.texture || scores.scoreTexture || 0);
  const sFilling = Number(scores.filling || scores.scoreFilling || 0);

  const cx = size / 2;
  const cy = size / 2;
  const maxRadius = size * 0.34;

  const axes = [
    { label: 'TEXTURA', val: sTexture, angle: -Math.PI / 2 },
    { label: 'MASSA', val: sDough, angle: 0 },
    { label: 'SABOR', val: sFlavor, angle: Math.PI / 2 },
    { label: 'RECHEIO', val: sFilling, angle: Math.PI }
  ];

  const pointAt = (angle, normVal) => {
    const r = normVal * maxRadius;
    return [cx + r * Math.cos(angle), cy + r * Math.sin(angle)];
  };

  const gridLevels = [0.25, 0.5, 0.75, 1.0];
  const gridPolygons = gridLevels
    .map((lvl) => {
      const pts = axes.map((a) => pointAt(a.angle, lvl).join(',')).join(' ');
      return `<polygon points="${pts}" fill="none" stroke="#F0C8DA" stroke-width="1" stroke-dasharray="${lvl < 1 ? '3,3' : 'none'}" />`;
    })
    .join('');

  const axisLines = axes
    .map((a) => {
      const [x2, y2] = pointAt(a.angle, 1.0);
      return `<line x1="${cx}" y1="${cy}" x2="${x2}" y2="${y2}" stroke="#E6B8CD" stroke-width="1.2" />`;
    })
    .join('');

  const dataPoints = axes.map((a) => pointAt(a.angle, Math.max(0.05, a.val / 10)));
  const dataPolygonPts = dataPoints.map((pt) => pt.join(',')).join(' ');

  const dotsAndLabels = axes
    .map((a, idx) => {
      const [px, py] = dataPoints[idx];
      const [lx, ly] = pointAt(a.angle, 1.27);
      return `
        <circle cx="${px}" cy="${py}" r="5.5" fill="#C42865" stroke="#FFFFFF" stroke-width="2" />
        <text x="${lx}" y="${ly - 5}" text-anchor="middle" fill="#2A1420" font-family="Plus Jakarta Sans, sans-serif" font-size="10.5" font-weight="700">${a.label}</text>
        <text x="${lx}" y="${ly + 10}" text-anchor="middle" fill="#C42865" font-family="JetBrains Mono, monospace" font-size="11.5" font-weight="700">${a.val.toFixed(1)}</text>
      `;
    })
    .join('');

  return `
    <div class="radar-svg-container" role="img" aria-label="Gráfico radar das notas: Textura ${sTexture.toFixed(1)}, Massa ${sDough.toFixed(1)}, Sabor ${sFlavor.toFixed(1)}, Recheio ${sFilling.toFixed(1)}">
      <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
        <circle cx="${cx}" cy="${cy}" r="${maxRadius}" fill="#FFF8F5" />
        ${gridPolygons}
        ${axisLines}
        <polygon points="${dataPolygonPts}" fill="rgba(196, 40, 101, 0.22)" stroke="#C42865" stroke-width="2.6" />
        ${dotsAndLabels}
      </svg>
    </div>
  `;
}

export function renderCriteriaBarsHTML(cakeOrScores, weights = { flavor: 25, dough: 25, texture: 25, filling: 25 }) {
  const items = [
    {
      key: 'texture',
      emoji: '🎈',
      label: 'Textura (Boca & Estrutura)',
      val: Number(cakeOrScores.scoreTexture ?? cakeOrScores.avgTexture ?? 0),
      weight: weights.texture
    },
    {
      key: 'dough',
      emoji: '🧁',
      label: 'Massa (Ponto & Umidade)',
      val: Number(cakeOrScores.scoreDough ?? cakeOrScores.avgDough ?? 0),
      weight: weights.dough
    },
    {
      key: 'flavor',
      emoji: '🍓',
      label: 'Sabor & Equilíbrio',
      val: Number(cakeOrScores.scoreFlavor ?? cakeOrScores.avgFlavor ?? 0),
      weight: weights.flavor
    },
    {
      key: 'filling',
      emoji: '🍯',
      label: 'Recheio & Ponto de Creme',
      val: Number(cakeOrScores.scoreFilling ?? cakeOrScores.avgFilling ?? 0),
      weight: weights.filling
    }
  ];

  return `
    <div class="criteria-bars-list">
      ${items
        .map((item) => {
          const pct = Math.min(100, Math.max(5, item.val * 10));
          return `
            <div class="crit-bar-row">
              <div class="crit-bar-top">
                <span><span aria-hidden="true">${item.emoji}</span> ${item.label} <small style="color:var(--text-muted);font-weight:500;">(peso ${item.weight}%)</small></span>
                <span style="font-family:var(--font-mono);color:var(--raspberry);font-size:1.02rem;">${item.val.toFixed(1)} <small style="color:var(--text-muted);">/ 10</small></span>
              </div>
              <div class="crit-bar-track">
                <div class="crit-bar-fill" style="width:${pct}%"></div>
              </div>
            </div>
          `;
        })
        .join('')}
    </div>
  `;
}
