# 🎬 ProwJack

**ProwJack** é um addon avançado para Stremio (v3.2.3) que integra indexadores do **Jackett** e **Prowlarr** com serviços Debrid (**Real-Debrid**, **TorBox**), **StremThru**, e **qBittorrent** nativo. Desenvolvido para oferecer a melhor experiência de streaming com foco em velocidade, cache inteligente e priorização de conteúdo.

---

## ✨ Funcionalidades Principais

* **Busca Universal:** Integra-se perfeitamente com Prowlarr e Jackett para consultar dezenas de trackers simultaneamente.
* **Múltiplos Motores de Streaming:**
  * **Debrid Nativo:** Integração ultrarrápida com Real-Debrid e TorBox.
  * **StremThru:** Compatibilidade total com a API do StremThru.
  * **qBittorrent HTTP:** Streaming nativo usando seu próprio cliente qBittorrent para trackers privados.
  * **P2P:** Links magnet diretos quando nenhum serviço premium estiver ativo.
* **Catálogo RSS Automático:** Exibe os últimos lançamentos do Prowlarr/Jackett diretamente na página inicial do Stremio.
* **Priorização Inteligente:** Ranking avançado priorizando dublagem (PT-BR) e resolução.
* **Performance e Cache:** Cache distribuído em Redis para máxima velocidade e contorno de limites de taxa (Rate Limit).

---

## 🚀 Como Iniciar (Quick Start)

A maneira mais recomendada de hospedar o ProwJack é utilizando o **Docker Compose**.

### 1. Requisitos
* Docker e Docker Compose instalados.
* Uma instância do **Prowlarr** ou **Jackett**.
* (Recomendado) Uma conta Debrid (TorBox, Real-Debrid) ou StremThru.

### 2. Configuração Docker

Crie um arquivo `docker-compose.yml`:

```yaml
version: '3.8'
services:
  prowjack:
    image: node:20-alpine
    container_name: prowjack
    working_dir: /app
    volumes:
      - ./:/app
    ports:
      - "7014:7014"
    environment:
      - NODE_ENV=production
    env_file:
      - .env
    command: npm start
    restart: unless-stopped
```

### 3. Variáveis de Ambiente (`.env`)

Crie um arquivo `.env` no mesmo diretório:

```bash
# Integração Prowlarr/Jackett (Obrigatório)
JACKETT_URL=http://prowlarr:9696
JACKETT_API_KEY=sua_api_key_aqui

# Cache (Recomendado)
REDIS_URL=redis://localhost:6379

# Porta do Servidor
PORT=7014
```

*(Outros recursos como qBittorrent e persistência avançada podem ser configurados neste arquivo. Consulte `.env.example` no código-fonte).*

### 4. Executando

```bash
docker-compose up -d
```

---

## 🎮 Como Usar no Stremio

1. Com o ProwJack rodando, acesse a interface web em seu navegador:
   👉 `http://IP_DO_SEU_SERVIDOR:7014/configure`
2. Selecione seus indexadores, idioma de preferência e configure sua conta Debrid / StremThru.
3. Clique em **Instalar** ou copie o link do manifest gerado e cole na barra de busca de Addons do Stremio.

---

## 🔐 Privacidade e Segurança
* **Auto-hospedado:** Seus dados e chaves de API não passam por servidores de terceiros.
* **Proteção de Acesso:** O `.env` suporta a variável `ACCESS_TOKEN` para travar o addon contra acessos indesejados.
* **Validação Rígida:** Proteções nativas contra *Path Traversal*, *ReDoS* e controle restrito de *CORS*.

---

*Desenvolvido pela comunidade, para a comunidade.* 🍿
