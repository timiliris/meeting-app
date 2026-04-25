# Meeting App

Petite application web auto-hébergée pour lancer des réunions interactives en un clic. Pas de compte, pas d'inscription : on partage une URL, on choisit un pseudo, et on prend des notes ensemble en temps réel.

## Fonctionnalités

- **Création instantanée** d'une réunion via un bouton sur la page d'accueil. Une URL unique est générée et peut être partagée à tout le monde.
- **Notes collaboratives en temps réel** synchronisées via WebSocket entre tous les participants.
- **Agenda / liste de sujets** : ajouter des sujets avec une description/explication, les cocher au fur et à mesure.
- **Sondages** : lancer des votes rapides à 2-10 options avec affichage des résultats en direct.
- **Liste des participants** connectés en temps réel.
- **Persistance** sur disque dans des fichiers JSON (un par réunion) — les données survivent aux redémarrages du conteneur.

## Lancer le projet

Prérequis : Docker et Docker Compose installés.

```bash
cd meeting-app
docker compose up -d --build
```

L'application est dispo sur **http://localhost:3001**.

Pour arrêter :

```bash
docker compose down
```

Les données persistent dans le dossier `./data` du host.

## Utilisation

1. Va sur `http://localhost:3001`.
2. Clique sur **+ Nouvelle réunion**.
3. Copie l'URL générée et envoie-la aux participants (Slack, e-mail, signal de fumée…).
4. Chaque participant ouvre l'URL, entre un pseudo, et c'est parti.
5. Tout le monde peut éditer les notes, ajouter des sujets, et lancer des sondages.

## Configuration

Variables d'environnement (modifiables dans `docker-compose.yml`) :

- `PORT` : port d'écoute interne du conteneur (défaut `3000`).
- `DATA_DIR` : chemin de stockage des fichiers JSON (défaut `/app/data`).

Pour exposer sur un autre port côté host, change la partie gauche du mapping dans `docker-compose.yml` (laisse `3000` à droite, c'est le port interne du conteneur) :

```yaml
ports:
  - "8080:3000"   # accessible sur http://localhost:8080
```

## Stack technique

- **Backend** : Node.js 20 + Express + Socket.io.
- **Persistance** : 1 fichier JSON par réunion (aucune dépendance native, déploiement zéro friction).
- **Frontend** : HTML/CSS/JS vanilla, pas de framework, pas de build step.
- **Image** : `node:20-alpine` (~50 Mo).

## Développement local sans Docker

```bash
cd meeting-app
npm install
node server.js
```

Puis ouvre `http://localhost:3000`.

## Limitations connues

- Pas d'authentification : quiconque a l'URL peut rejoindre et éditer. Pour un usage interne / réunions éphémères c'est voulu, mais ne mets pas ça brut sur Internet sans réfléchir.
- Édition simultanée des notes en mode "dernière écriture gagne" (debounce 250 ms). Suffisant pour ~10 participants ; au-delà ou pour un usage type Google Docs il faudrait un CRDT (Yjs, Automerge…).
- Stockage JSON : très bien jusqu'à quelques milliers de réunions. Au-delà passer à SQLite/Postgres.

## Exposer sur Internet

Si tu veux que ta réunion soit accessible depuis l'extérieur :

- **Rapide** : `ngrok http 3001` ou `cloudflared tunnel --url http://localhost:3001`.
- **Stable** : reverse proxy (Caddy/Nginx) + HTTPS sur ton domaine. Pense à activer les WebSockets dans la config du proxy.
