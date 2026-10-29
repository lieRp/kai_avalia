@echo off
chcp 65001 >nul
echo ============================================================
echo   Sugarcube Corner - Publicando atualizacao no GitHub Pages
echo ============================================================
python server.py --build-pages docs
git add -A
git commit -m "chore: atualizacao do Sugarcube Corner"
git push origin main
echo.
echo [OK] Atualizacao enviada! Em ~40 segundos estara no ar em kaiavalia.com.br
pause
