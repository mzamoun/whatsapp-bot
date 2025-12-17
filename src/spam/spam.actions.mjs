import { botState } from '../bot/bot.state.mjs';

/**
 * UNIFICATION : Applique les actions de sanction (log, delete, block, kick) à un message spam.
 * @param {string} jid - JID du groupe
 * @param {object} msg - Objet message de Baileys
 * @param {object} meta - GroupMetadata
 * @returns {Promise<string>} Résultat de l'action
 */
export async function handleSpamAction(jid, msg, meta) {
    const sock = botState.sock;

    console.log("Message spam detected : msg.key ", msg.key, " jid:", jid)

    const sender = msg.key.participant || msg.key.remoteJid;
    const botJID = sock.user.id; // JID du bot
    let botLID = sock.user.lid;
    botLID = botLID.replace(":80", "");

    console.log("sender :", sender)
    console.log("botLID :", botLID)
    console.log("botJID :", botJID)

    console.log("msg: ", msg)
    console.log("sock.user : ", sock.user)
    // console.log("sock : ", sock )

    // console.log("meta : ", meta )
    console.log("participants : ", meta.participants)
    // console.log("botJID : ", botJID )

    const botParticipant = meta.participants.find(p => p.id === botLID);
    console.log("botParticipant : ", botParticipant)
    const isAdmin = botParticipant && (botParticipant.admin == "superadmin" || botParticipant.admin == "admin" || botParticipant.admin == "true" || botParticipant.isAdmin || botParticipant.isSuperAdmin);
    console.log("isAdmin : ", isAdmin)

    let isSenderBot = (sender === botLID)

    console.log("isSenderBot=", isSenderBot)

    // let msgBot = `🚨 BOT : Auto-SPAM détecté.\nLe message va etre supprimé car Bot est Admin ici.\n`
    let msgBot = `Message spam supprimé par admin.\n`
    // msgBot += `msg.key = ${msg.key}\n jid = ${jid}`
    if (!isAdmin) msgBot = ""

    try {
        // 1. Log dans le groupe (optionnel, pour alerter qu'il s'agit d'un auto-spam)
        // on ne le fait que lorsqu'on est admin afin de ne pas trop spamer !
        if (isAdmin) {
            await sock.sendMessage(jid, {
                text: msgBot
            });

            // 2. Supprimer son propre message
            console.log("av suppresion msg ", msg.key, "jid", jid)

            try {
                // msg.key est l'objet Key complet du message reçu
                let x = await sock.sendMessage(jid, { delete: msg.key });
                // action_taken = "Message supprimé.";
                console.log("Message deleted x=", x)
            } catch (e) {
                // action_taken = `Erreur de suppression: ${e.message}`;
                console.log(`Erreur de suppression: ${e.message}`)
            }
        }

        // return "Auto-spam (Bot). Message supprimé uniquement.";
    } catch (e) {
        console.error(`Erreur lors de l'auto-suppression pour ${jid}:`, e.message);
        return "Auto-spam (Bot). Échec de la suppression.";
    }

    // --- 💡 AJOUT DE LA VÉRIFICATION DU BOT ---
    if (isSenderBot) {
        // Le bot ne peut pas se bloquer ou se kicker.
        // Il peut par contre supprimer son propre message.
        // try {
        //     // 1. Log dans le groupe (optionnel, pour alerter qu'il s'agit d'un auto-spam)
        //     await sock.sendMessage(jid, {
        //         text: `🚨 Auto-SPAM détecté (message du bot).\nLe message a été supprimé.`
        //     });
        //     // 2. Supprimer son propre message
        //     await sock.sendMessage(jid, { delete: msg.key });
        //     return "Auto-spam (Bot). Message supprimé uniquement.";
        // } catch (e) {
        //     console.error(`Erreur lors de l'auto-suppression pour ${jid}:`, e.message);
        //     return "Auto-spam (Bot). Échec de la suppression.";
        // }
    }
    // ------------------------------------------

    if (!isAdmin) {
        return "Bot n'est pas administrateur. Aucune action prise.";
    }

    if (!sender) {
        return "Erreur: Expéditeur (sender) manquant. Suppression uniquement.";
    }

    // Récupération du nom de l'expéditeur non-bot
    const senderName = meta.participants.find(p => p.id === sender)?.notify || sender.split('@')[0];

    try {
        // 1. Log dans le groupe
        // await sock.sendMessage(jid, {
        //     text: `🚨 SPAM détecté chez *${senderName}*.\nLe message a été supprimé, utilisateur bloqué et expulsé (si possible).`
        // });

        // 2. Supprimer le message
        await sock.sendMessage(jid, { delete: msg.key });

        if (!isSenderBot) {
            // 3. Bloquer l'utilisateur

            await sock.updateBlockStatus(sender, 'block');
            // 4. KICK (expulser)
            const kickResult = await sock.groupParticipantsUpdate(jid, [sender], "remove");
            const isKicked = kickResult.length > 0 && kickResult[0].status === '200';

            return `Message supprimé, Utilisateur bloqué, Expulsion: ${isKicked ? 'OK' : 'Échec/Non requis'}`;
        }


    } catch (actionError) {
        console.error(`Erreur lors de l'action anti-spam pour ${sender} dans ${jid}:`, actionError.message);
        return `Erreur d'action admin: ${actionError.message}`;
    }

}
