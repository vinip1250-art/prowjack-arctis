# ProwJack v3.2.1

Addon Stremio para busca via Prowlarr/Jackett com suporte a Debrid (TorBox, Real-Debrid), StremThru, qBittorrent e catálogo RSS.

---

## Changelog

### v3.2.1 (2026-06-07)

**Correções de bugs**

- **Race condition no `streamWaiters`**: substituído `Map.has/set` não-atômico por lock baseado em `Promise` — elimina buscas duplicadas simultâneas para o mesmo conteúdo (ex: 3 buscas paralelas para o mesmo filme).
- **Modo StremThru — streams não apareciam no Stremio**: manifest com `stConfig` agora redireciona `302` direto para a URL do proxy StremThru. O Stremio instala o addon StremThru nativamente, eliminando problemas de campos inválidos e `notWebReady`.
- **`notWebReady: true` em streams StremThru**: `fetchScrapStreams` agora força `notWebReady: false` em todos os streams recebidos de addons externos.
- **ID de config não-determinístico**: `saveStoredConfig` substituiu `randomBytes` por `sha256(JSON.stringify(prefs))` — mesmas configurações sempre geram o mesmo URL, evitando que o upstream mude a cada geração e invalide o cache.
- **qBittorrent no modo StremThru**: upstream preserva `qbitMode` original — retorna P2P + qBit juntos; o StremThru converte os P2P em debrid e repassa os HTTP.
- **Trackers privados sem P2P no upstream StremThru**: `isPrivateTracker` agora retorna `[qbitStream, p2pPrivate]` usando `EXTRA_TRACKERS` em vez de apenas `qbitStream` — permite ao StremThru converter para debrid.
- **Formatação dupla em streams do scrap**: streams de addons externos com `infoHash` usam `name`/`description` originais em vez de `formatStream` do ProwJack.
- **Links não reproduzíveis do scrap no modo debrid**: streams sem `infoHash` (links diretos, usenet) são descartados no modo debrid nativo.
- **Arquivos não reproduzíveis (`.iso`, `.rar`, etc.)**: adicionado filtro `BAD_EXT_RE` — streams cujo arquivo selecionado tem extensão não-reproduzível são descartados.
- **Login qBittorrent v5.x**: qBit >= 5 retorna HTTP 204 com body vazio no login em vez de `"Ok."` — aceita ambos os formatos.
- **Logs de performance**: adicionados `[PERF] search=Xms`, `[PERF] debrid=Xms`, `[PERF] stremthru=Xms`, `[PERF] total=Xms`.
- **Logs de pipeline**: adicionado `[DEBUG] Provider retornou: N | Candidatos: N | Com hash: N | Dedupe: N | Final: N`.
- **UI — StremThru destacado e acima do Debrid Nativo**: seção StremThru com badge "Recomendado" e posicionada antes do Debrid Nativo na página de configuração.

---

## Modos de operação

| Modo | Descrição |
|------|-----------|
| **P2P** | Retorna magnet links com `infoHash` + `sources`. |
| **qBittorrent** | Retorna URL HTTP via instância local do qBit. |
| **Debrid Nativo** | TorBox e/ou Real-Debrid direto — cache check + link direto. |
| **StremThru** | Proxy debrid via StremThru — upstream P2P convertido para debrid. Recomendado. |

## Variáveis de ambiente

```env
JACKETT_URL=http://prowlarr:9696
JACKETT_API_KEY=sua_chave
REDIS_URL=redis://redis:6379/5
ADDON_PUBLIC_URL=https://seu-dominio.com
ACCESS_TOKEN=token_opcional
QBIT_URL=http://host:5000
QBIT_USER=admin
QBIT_PASS=senha
QBIT_SAVE_DIR=/data/prowjack
```

## Docker

```bash
docker compose up -d
```
