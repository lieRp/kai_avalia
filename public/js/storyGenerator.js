/**
 * Sugarcube Corner — Gerador de Card 9:16 para Instagram Stories (1080x1920)
 * - Aguarda carregamento de fontes (document.fonts.load) antes de desenhar
 * - Respeita margens internas estritas para nunca vazar da moldura
 * - Inclui a URL direta do site/avaliação no rodapé para gerar tráfego real dos Stories
 */

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function wrapText(ctx, text, x, y, maxWidth, lineHeight, maxLines = 4) {
  const words = String(text || '').split(' ');
  let line = '';
  let currentY = y;
  let linesCount = 0;

  for (let n = 0; n < words.length; n++) {
    const testLine = line + words[n] + ' ';
    const metrics = ctx.measureText(testLine);
    if (metrics.width > maxWidth && n > 0) {
      linesCount++;
      if (linesCount >= maxLines) {
        ctx.fillText(line.trim() + '…', x, currentY);
        return currentY + lineHeight;
      }
      ctx.fillText(line.trim(), x, currentY);
      line = words[n] + ' ';
      currentY += lineHeight;
    } else {
      line = testLine;
    }
  }
  ctx.fillText(line.trim(), x, currentY);
  return currentY + lineHeight;
}

async function loadImageSafe(url) {
  if (!url) return null;
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

async function ensureCanvasFontsLoaded() {
  if (document.fonts && document.fonts.load) {
    try {
      await Promise.all([
        document.fonts.load('700 28px "Plus Jakarta Sans"'),
        document.fonts.load('600 26px "Plus Jakarta Sans"'),
        document.fonts.load('700 54px "Fraunces"'),
        document.fonts.load('700 68px "JetBrains Mono"')
      ]);
      await document.fonts.ready;
    } catch (_) {}
  }
}

function drawSubtlePonyAndBalloons(ctx, W, H) {
  ctx.save();
  ctx.globalAlpha = 0.14;
  ctx.fillStyle = '#227FB0';
  ctx.beginPath();
  ctx.ellipse(W - 140, 210, 26, 32, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = '#F7C852';
  ctx.beginPath();
  ctx.ellipse(W - 95, 190, 26, 32, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = '#C42865';
  ctx.beginPath();
  ctx.ellipse(W - 115, 240, 24, 30, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.globalAlpha = 0.08;
  ctx.fillStyle = '#C42865';
  ctx.beginPath();
  ctx.arc(W - 180, H - 180, 34, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(W - 135, H - 145, 48, 28, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

export async function renderStoryCardToCanvas(canvas, cake) {
  await ensureCanvasFontsLoaded();

  const ctx = canvas.getContext('2d');
  const W = 1080;
  const H = 1920;
  canvas.width = W;
  canvas.height = H;

  // 1. Fundo Editorial Sugarcube Corner
  const bgGrad = ctx.createLinearGradient(0, 0, W, H);
  bgGrad.addColorStop(0, '#FFF8F5');
  bgGrad.addColorStop(0.55, '#FFEFF6');
  bgGrad.addColorStop(1, '#EBF7FD');
  ctx.fillStyle = bgGrad;
  ctx.fillRect(0, 0, W, H);

  drawSubtlePonyAndBalloons(ctx, W, H);

  // Moldura interna segura (margem 44px)
  ctx.strokeStyle = '#F5B5D0';
  ctx.lineWidth = 5;
  roundRect(ctx, 44, 44, W - 88, H - 88, 42);
  ctx.stroke();

  // 2. Cabeçalho da Marca
  ctx.textAlign = 'left';
  ctx.fillStyle = '#C42865';
  roundRect(ctx, 84, 86, 390, 52, 26);
  ctx.fill();

  ctx.fillStyle = '#FFFFFF';
  ctx.font = '700 23px "Plus Jakarta Sans", sans-serif';
  ctx.fillText('🎈 FEIRA DE SANTANA • BA', 110, 120);

  if (cake.kaiApproved) {
    ctx.fillStyle = '#2A1420';
    roundRect(ctx, W - 430, 86, 346, 52, 26);
    ctx.fill();
    ctx.fillStyle = '#FFE066';
    ctx.font = '700 22px "Plus Jakarta Sans", sans-serif';
    ctx.fillText('✨ APROVADO POR KAI', W - 398, 120);
  }

  const iconUrl = new URL('../assets/sugarcube-icon.png', import.meta.url).href;
  const iconImg = await loadImageSafe(iconUrl);
  if (iconImg) {
    ctx.drawImage(iconImg, 84, 162, 62, 64);
    ctx.fillStyle = '#2A1420';
    ctx.font = '700 54px "Fraunces", Georgia, serif';
    ctx.fillText('Sugarcube Corner', 160, 212);
  } else {
    ctx.fillStyle = '#2A1420';
    ctx.font = '700 54px "Fraunces", Georgia, serif';
    ctx.fillText('🧁 Sugarcube Corner', 84, 212);
  }

  ctx.fillStyle = '#523243';
  ctx.font = '600 26px "Plus Jakarta Sans", sans-serif';
  ctx.fillText('Crítica Sensorial de Bolos • por Kai Tavares', 84, 254);

  // 3. Foto do Bolo
  const imgX = 84;
  const imgY = 290;
  const imgW = W - 168;
  const imgH = 510;

  ctx.save();
  roundRect(ctx, imgX, imgY, imgW, imgH, 34);
  ctx.clip();

  const photoUrl = cake.photos && cake.photos[0];
  const loadedImg = await loadImageSafe(photoUrl);

  if (loadedImg) {
    const scale = Math.max(imgW / loadedImg.width, imgH / loadedImg.height);
    const sw = loadedImg.width * scale;
    const sh = loadedImg.height * scale;
    const sx = imgX + (imgW - sw) / 2;
    const sy = imgY + (imgH - sh) / 2;
    ctx.drawImage(loadedImg, sx, sy, sw, sh);
  } else {
    const fallbackGrad = ctx.createLinearGradient(imgX, imgY, imgX + imgW, imgY + imgH);
    fallbackGrad.addColorStop(0, '#C42865');
    fallbackGrad.addColorStop(1, '#227FB0');
    ctx.fillStyle = fallbackGrad;
    ctx.fillRect(imgX, imgY, imgW, imgH);
    ctx.fillStyle = '#FFF';
    ctx.font = '110px sans-serif';
    ctx.fillText('🧁', W / 2 - 55, imgY + imgH / 2 + 36);
  }

  const darkOverlay = ctx.createLinearGradient(0, imgY + imgH - 200, 0, imgY + imgH);
  darkOverlay.addColorStop(0, 'rgba(42,20,32,0)');
  darkOverlay.addColorStop(1, 'rgba(42,20,32,0.88)');
  ctx.fillStyle = darkOverlay;
  ctx.fillRect(imgX, imgY + imgH - 200, imgW, 200);

  ctx.fillStyle = '#FFE066';
  ctx.font = '700 26px "Plus Jakarta Sans", sans-serif';
  wrapText(
    ctx,
    `${cake.bakery?.name || 'Confeitaria'} • ${cake.bakery?.neighborhood || 'Feira de Santana'}`,
    imgX + 32,
    imgY + imgH - 40,
    imgW - 300,
    34,
    1
  );
  ctx.restore();

  // Badge da Nota Final Flutuante
  const badgeW = 224;
  const badgeH = 144;
  const badgeX = W - 84 - badgeW - 24;
  const badgeY = imgY + imgH - badgeH - 20;

  ctx.fillStyle = '#2A1420';
  roundRect(ctx, badgeX, badgeY, badgeW, badgeH, 26);
  ctx.fill();
  ctx.strokeStyle = '#FFE066';
  ctx.lineWidth = 3;
  ctx.stroke();

  ctx.textAlign = 'center';
  ctx.fillStyle = '#FFE066';
  ctx.font = '700 68px "JetBrains Mono", monospace';
  ctx.fillText(Number(cake.finalScore).toFixed(1), badgeX + badgeW / 2, badgeY + 84);

  ctx.fillStyle = '#FFFFFF';
  ctx.font = '700 20px "Plus Jakarta Sans", sans-serif';
  ctx.fillText('NOTA DE KAI', badgeX + badgeW / 2, badgeY + 120);
  ctx.textAlign = 'left';

  // 4. Nome do Bolo Avaliado
  ctx.fillStyle = '#2A1420';
  ctx.font = '700 42px "Fraunces", Georgia, serif';
  const nextY = wrapText(ctx, cake.name, 84, 860, W - 168, 52, 2);

  // Metadados (Categoria + Preço + Data)
  ctx.fillStyle = '#523243';
  ctx.font = '600 25px "Plus Jakarta Sans", sans-serif';
  ctx.fillText(
    `${cake.category}  •  R$ ${Number(cake.approxPrice).toFixed(2).replace('.', ',')}  •  Visita: ${cake.visitedAt}`,
    84,
    nextY + 8
  );

  // 5. Card das 4 Notas Sensoriais
  const boxY = nextY + 42;
  const boxH = 400;
  ctx.fillStyle = '#FFFFFF';
  roundRect(ctx, 84, boxY, W - 168, boxH, 30);
  ctx.fill();
  ctx.strokeStyle = '#F5B5D0';
  ctx.lineWidth = 2.5;
  ctx.stroke();

  const criteria = [
    { label: '🎈 TEXTURA (BOCA & ESTRUTURA)', val: Number(cake.scoreTexture) },
    { label: '🧁 MASSA (PONTO & UMIDADE)', val: Number(cake.scoreDough) },
    { label: '🍓 SABOR & EQUILÍBRIO', val: Number(cake.scoreFlavor) },
    { label: '🍯 RECHEIO & CREMOSIDADE', val: Number(cake.scoreFilling) }
  ];

  criteria.forEach((c, idx) => {
    const rowY = boxY + 54 + idx * 88;
    ctx.fillStyle = '#2A1420';
    ctx.font = '700 24px "Plus Jakarta Sans", sans-serif';
    ctx.fillText(c.label, 120, rowY);

    ctx.textAlign = 'right';
    ctx.fillStyle = '#C42865';
    ctx.font = '700 30px "JetBrains Mono", monospace';
    ctx.fillText(`${c.val.toFixed(1)}/10`, W - 120, rowY);
    ctx.textAlign = 'left';

    const barX = 120;
    const barY = rowY + 14;
    const barW = W - 240;
    const barH = 20;
    ctx.fillStyle = '#FFEAF3';
    roundRect(ctx, barX, barY, barW, barH, 10);
    ctx.fill();

    const fillW = Math.max(24, (c.val / 10) * barW);
    const barGrad = ctx.createLinearGradient(barX, 0, barX + fillW, 0);
    barGrad.addColorStop(0, '#227FB0');
    barGrad.addColorStop(0.5, '#7B4BB3');
    barGrad.addColorStop(1, '#C42865');
    ctx.fillStyle = barGrad;
    roundRect(ctx, barX, barY, fillW, barH, 10);
    ctx.fill();
  });

  // 6. Veredito curto de Kai
  const quoteY = boxY + boxH + 30;
  const quoteH = 230;
  ctx.fillStyle = '#FFF0F6';
  roundRect(ctx, 84, quoteY, W - 168, quoteH, 28);
  ctx.fill();
  ctx.strokeStyle = '#F5B5D0';
  ctx.lineWidth = 2;
  ctx.stroke();

  ctx.fillStyle = '#C42865';
  ctx.font = '700 23px "Plus Jakarta Sans", sans-serif';
  ctx.fillText('💬 VEREDITO SENSORIAL DE KAI TAVARES:', 116, quoteY + 46);

  ctx.fillStyle = '#2A1420';
  ctx.font = 'italic 25px "Fraunces", Georgia, serif';
  wrapText(ctx, `"${cake.kaiVerdict}"`, 116, quoteY + 90, W - 232, 38, 3);

  // 7. Rodapé Dentro da Moldura com o Endereço do Site (CTA para visitas)
  const footerBoxY = H - 150;
  ctx.fillStyle = '#2A1420';
  roundRect(ctx, 84, footerBoxY, W - 168, 76, 38);
  ctx.fill();

  const siteHost = window.location.host || 'sugarcubecorner.com.br';
  const sharePath = cake.slug ? `${siteHost}/bolo/${cake.slug}` : siteHost;

  ctx.textAlign = 'center';
  ctx.fillStyle = '#FFE066';
  ctx.font = '700 24px "Plus Jakarta Sans", sans-serif';
  ctx.fillText(`🔗 Acesse o ranking: ${sharePath.slice(0, 48)}`, W / 2, footerBoxY + 47);
  ctx.textAlign = 'left';
}
