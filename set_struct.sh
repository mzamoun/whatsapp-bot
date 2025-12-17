# Dossier racine
mkdir -p src/{bot,spam,routes,utils,config}

# Fichiers à la racine
touch src/server.mjs
touch src/app.mjs

# Bot
touch src/bot/bot.state.mjs
touch src/bot/bot.start.mjs
touch src/bot/bot.events.mjs

# Spam
touch src/spam/spam.config.mjs
touch src/spam/spam.matcher.mjs
touch src/spam/spam.actions.mjs
touch src/spam/spam.processor.mjs
touch src/spam/spam.scan.mjs

# Routes
touch src/routes/bot.routes.mjs
touch src/routes/groups.routes.mjs
touch src/routes/scan.routes.mjs

# Utils
touch src/utils/date.utils.mjs
touch src/utils/fs.utils.mjs

# Config
touch src/config/constants.mjs
