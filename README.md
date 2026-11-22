# KI-chat (chatlikewebui)

En chat som virker som ChatGPT, på Digital Revisors OpenWebUI (`http://217.149.113.34:3000`).

- **Innlogging med OpenWebUI-kontoen** (e-post og passord), eller med en OpenWebUI API-nøkkel. OpenWebUI-tokenet ligger kryptert i en HttpOnly-informasjonskapsel, så nettleseren ser det aldri, og serveren holder ingen økter.
- **Samtaler** til venstre, gruppert etter dato, med søk, festing, nytt navn og sletting. Hver person ser bare sine egne.
- **Modeller og agenter** fra OpenWebUI (agenter er OpenWebUI-modeller med grunnmodell, instruksjoner, kunnskap og verktøy), med forslag til spørsmål.
- **Svar strømmes** ord for ord og kan stoppes, svares på nytt, eller spørsmålet redigeres. Markdown med tabeller og kode. Kilder fra kunnskap vises under svaret.
- **Vedlegg** (klikk, dra inn eller lim inn). Bilder sendes til modellen, andre filer leses av OpenWebUI og søkes i.
- **Kunnskap, verktøy, nettsøk, kodetolk og bildegenerering** per samtale, og **prompter** med `/`.
- **Egne instruksjoner** (systemprompt) per samtale.
- **For administratorer i OpenWebUI**: lage og slette agenter, lage kunnskapsbaser og legge til eller fjerne filer, og se verktøy, funksjoner og prompter.

Alt går med personens eget OpenWebUI-token, så det er rettighetene i OpenWebUI som avgjør hva hver person ser og kan endre.

## Kjøre lokalt

```sh
npm install
npm run build
SESSION_SECRET=$(openssl rand -hex 32) npm start        # http://localhost:3800
```

Under utvikling: `npm run dev:server` i ett vindu og `npm run dev` i et annet (siden på http://localhost:5180, kall til `/api` går til 3800).

`npm test` kjører servertestene (mot en falsk OpenWebUI). `npm run typecheck` sjekker typene i server og nettside.

## Innstillinger

Se [.env.example](.env.example).

| Variabel | Betydning |
|---|---|
| `OPENWEBUI_URL` | OpenWebUI-instansen. Standard er `http://217.149.113.34:3000`. |
| `SESSION_SECRET` | Krypterer innloggingen. Må settes, ellers logges alle ut ved omstart. |
| `SESSION_HOURS` | Hvor lenge en innlogging varer (standard 12 timer). |
| `APP_URL` | Adressen folk åpner. Med `https://` blir informasjonskapselen `Secure`. |
| `PORT` | Standard 3800. |
| `DATA_DIR` | Hvor samtalene lagres, én mappe per person. |

Ingen API-nøkkel legges i koden eller i `.env`: hver person logger inn med sin egen konto.

## Drift

- `deploy/chatlikewebui.service`: systemd-tjeneste (bygg med `npm ci && npm run build` i `/opt/chatlikewebui`).
- `deploy/nginx.example.conf`: nginx foran appen. `proxy_buffering off` på `/api/owui/chats/stream` er nødvendig for at svarene skal strømme.
- `Dockerfile`: alternativt som container, med samtalene i volumet `/data`.

Ta sikkerhetskopi av `DATA_DIR`.

## API

Alle kall under `/api/owui` krever innlogging.

| Metode | Sti | |
|---|---|---|
| POST | `/api/login` | `{email, password}` eller `{apiKey}` |
| POST | `/api/logout` | |
| GET | `/api/me` | Innlogget person |
| GET | `/api/owui/status` | Når OpenWebUI fram, og versjon |
| GET | `/api/owui/catalog` | Modeller, kunnskap, verktøy, funksjoner og prompter på én gang |
| GET | `/api/owui/models`, `/knowledge`, `/knowledge/:id`, `/tools`, `/functions`, `/prompts` | |
| POST | `/api/owui/knowledge` | Ny kunnskapsbase |
| POST | `/api/owui/knowledge/:id/files` | Last opp filer til kunnskapsbasen (`files`) |
| DELETE | `/api/owui/knowledge/:id/files/:fileId`, `/api/owui/knowledge/:id` | |
| POST | `/api/owui/agents` | Ny agent |
| DELETE | `/api/owui/agents/:id` | |
| POST | `/api/owui/files` | Last opp vedlegg (`files`) |
| GET | `/api/owui/chats`, `/api/owui/chats/:id` | |
| PATCH | `/api/owui/chats/:id` | `{title, pinned, settings}` |
| DELETE | `/api/owui/chats/:id` | |
| POST | `/api/owui/chats/stream` | Send melding; svaret kommer som server-sent events: `chat`, `delta`, `sources`, `error`, `done` |

Panelene på risikosidene, i arbeidspapir og i bankforespørsler ligger fortsatt i Risk-appen.
