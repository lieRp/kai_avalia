# 🧁 Sugarcube Corner — O Guia de Confeitarias por Kai Tavares (Feira de Santana - BA)

Portal autoral de avaliação e ranking dos melhores bolos e confeitarias de **Feira de Santana - BA**, assinado por **Kai Tavares**. Visualmente inspirado na **Sugarcube Corner** (*My Little Pony*), com estética de confeitaria editorial sofisticada, **100% neutro e livre de pronomes** para Kai.

---

## 🔒 Arquitetura & Segurança (Hardened Production-Ready)

1. **Isolamento Estrito de Arquivos Estáticos (`public/`)**
   - O servidor entrega **apenas** arquivos dentro de `public/`.
   - Tentativas de acessar `/server.py`, `/data/sugarcube.db`, `/data/seed.json` ou caminhos com `..` retornam `404 Not Found`.
2. **Autenticação Real no Servidor (`scrypt` + Cookie Assinado)**
   - Senha do painel administrativo armazenada exclusivamente na tabela `admin_auth` do SQLite com hash `hashlib.scrypt` e `salt` criptográfico individual.
   - Sessão mantida via cookie `HttpOnly; SameSite=Strict` assinado com `HMAC-SHA256`.
   - Nenhuma senha ou hash é exposto em rotas públicas, no `seed.json` ou neste documento.
3. **Banco de Dados Relacional SQLite & Rotas Atômicas**
   - Tabelas separadas: `settings`, `admin_auth`, `bakeries`, `cakes`, `upcoming_bakeries`, `public_suggestions` e `visitor_rate_log`.
   - Ações públicas (`POST /api/public/react`, `/api/public/vote-upcoming`, `/api/public/suggest`) fazem **incrementos atômicos** com *rate limiting* por IP e nunca sobrescrevem o estado do site.
   - Rotas de escrita administrativa (`/api/admin/*`) exigem sessão autenticada, validam limites de payload (`MAX_JSON_BODY = 256 KB`, `MAX_UPLOAD_BODY = 5 MB`), verificam *magic bytes* reais de imagem (PNG, JPEG, WEBP, GIF) e geram **backups automáticos rotativos** em `data/backups/`.
4. **SEO Server-Side & Open Graph Dinâmico**
   - Rotas limpas com History API (`/`, `/ranking`, `/confeitaria/:slug`, `/bolo/:slug`, `/mapa`, `/em-breve`, `/sobre`, `/admin`).
   - O `server.py` injeta no HTML de cada URL as tags `<title>`, `<meta name="description">`, `<link rel="canonical">`, Open Graph (`og:title`, `og:description`, `og:image`, `og:url`) e dados estruturados **Schema.org JSON-LD** (`Review`, `Bakery`, `WebSite`) antes de entregar ao navegador ou aos bots do WhatsApp, Instagram e Google.

---

## 🚀 Como Rodar o Projeto

Certifique-se de ter **Python 3.10+** instalado. Nenhuma dependência externa é necessária (100% biblioteca padrão do Python).

```powershell
python server.py 8080
```

Depois, abra no navegador:
👉 **http://localhost:8080**

### Comandos Administrativos de CLI (`server.py`)

- **Definir uma nova senha administrativa via terminal:**
  ```powershell
  python server.py 8080 --set-password "SuaNovaSenhaForteAqui"
  ```
- **Limpar o banco de dados para o estado inicial limpo (sem dados fictícios):**
  ```powershell
  python server.py 8080 --reset-clean
  ```
- **Onde encontrar a senha gerada na primeira execução:**
  Se nenhuma senha for definida via `--set-password` ou variável de ambiente `SUGARCUBE_ADMIN_PASSWORD`, o servidor gera uma senha aleatória forte na primeira inicialização e salva localmente em:
  `data/admin_credentials_local.txt` *(arquivo fora da pasta `public/`, nunca acessível via web)*.

### Variáveis de Ambiente para Produção (HTTPS / Domínio Real)

Ao publicar atrás de um proxy reverso HTTPS (como **Caddy** ou **Nginx**):
- `SUGARCUBE_SITE_URL`: URL canônica pública (ex.: `https://sugarcubecorner.com.br`) usada para montar os links absolutos do `sitemap.xml`, `robots.txt` e imagens `og:image`.
- `SUGARCUBE_ADMIN_PASSWORD`: Senha inicial do admin caso o banco esteja sendo criado do zero.

---

## 📁 Estrutura de Arquivos

```text
├── server.py                  # Servidor ThreadingHTTPServer + API REST + SSR Open Graph/JSON-LD + SQLite
├── data/                      # Fora da web pública (NUNCA servido estaticamente)
│   ├── seed.json              # Configuração base limpa (sem avaliações ou números fictícios)
│   ├── sugarcube.db           # Banco SQLite relacional
│   └── backups/               # Backups automáticos (.db) antes de alterações administrativas
└── public/                    # Única pasta servida publicamente via HTTP
    ├── index.html             # Shell HTML semântico com placeholders SSR de SEO/Open Graph
    ├── assets/
    │   └── og-sugarcube.svg   # Arte oficial local para prévia de compartilhamento
    ├── uploads/               # Fotos reais enviadas por Kai via painel Admin
    ├── css/
    │   └── styles.css         # Design System Sugarcube Corner (WCAG AA + prefers-reduced-motion)
    └── js/
        ├── store.js           # Cliente da API REST, cálculo de notas e média Bayesiana
        ├── charts.js          # Gráfico Radar SVG e Barras de Critérios acessíveis
        ├── storyGenerator.js  # Gerador de Card 9:16 (1080x1920) para Instagram Stories
        └── app.js             # Roteador History API, views e Painel Admin de Kai
```
