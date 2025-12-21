const TelegramBot = require('node-telegram-bot-api');
const fetch = require('node-fetch');
const https = require('https');
const fs = require('fs');
const path = require('path');

// Configuración
const TOKEN = '8272381619:AAGy9netoupQboX1WgI5I59fQvZkz_4OlLs';
const ADMIN_ID = 8382571809;

// Configuración mejorada para evitar errores de conexión
const options = {
    polling: {
        interval: 1000,
        autoStart: false,
        params: {
            timeout: 60
        }
    },
    request: {
        agentOptions: {
            keepAlive: true,
            keepAliveMsecs: 1000,
            maxSockets: 5,
            maxFreeSockets: 2,
            timeout: 60000,
            family: 4
        }
    }
};

const bot = new TelegramBot(TOKEN, options);

// Configuración JSONbin
const JSONBIN_BIN_ID = process.env.JSONBIN_BIN_ID;
const JSONBIN_MASTER_KEY = process.env.JSONBIN_MASTER_KEY;
const JSONBIN_URL = `https://api.jsonbin.io/v3/b/${JSONBIN_BIN_ID}`;
const JSONBIN_URL_LATEST = `https://api.jsonbin.io/v3/b/${JSONBIN_BIN_ID}/latest`;

// Health check endpoint for Railway
const express = require('express');
const app = express();
const port = process.env.PORT || 3000;

app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

app.listen(port, () => {
  console.log(`Health check server running on port ${port}`);
});

// Estructura de base de datos inicial
const initialDatabase = {
    users: {},
    settings: {
        minInvestment: 10,
        maxInvestment: 50000,
        profitRate: 32.58,
        investmentDuration: 4
    },
    stats: {
        totalUsers: 0,
        totalInvested: 0,
        totalProfits: 0,
        lastUpdate: new Date().toISOString()
    }
};

// Variables globales
let database = JSON.parse(JSON.stringify(initialDatabase)); // Copia profunda
const sentNotifications = new Map(); // Para evitar duplicados
let isPolling = false;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 10;

// Función para verificar token con múltiples métodos
async function verifyTokenWithRetry(maxRetries = 5) {
    const methods = [
        async () => {
            const agent = new https.Agent({
                keepAlive: true,
                family: 4,
                timeout: 15000,
                rejectUnauthorized: false
            });

            const response = await fetch(`https://api.telegram.org/bot${TOKEN}/getMe`, {
                agent: agent,
                timeout: 15000
            });

            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            return await response.json();
        },

        async () => {
            return await bot.getMe();
        },

        async () => {
            const response = await fetch(`https://api.telegram.org/bot${TOKEN}/getMe`, {
                timeout: 10000
            });

            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            return await response.json();
        }
    ];

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        for (let methodIndex = 0; methodIndex < methods.length; methodIndex++) {
            try {
                console.log(`🔍 Verificando token (intento ${attempt}/${maxRetries}, método ${methodIndex + 1})...`);

                const data = await methods[methodIndex]();

                if (data.ok) {
                    console.log('✅ Token verificado exitosamente!');
                    console.log(`📱 Nombre: ${data.result.first_name}`);
                    console.log(`🆔 Username: @${data.result.username || 'N/A'}`);
                    return data.result;
                } else {
                    throw new Error(data.description || 'Token inválido');
                }
            } catch (error) {
                console.error(`❌ Método ${methodIndex + 1} fallido:`, error.message);

                if (methodIndex === methods.length - 1 && attempt === maxRetries) {
                    throw error;
                }

                await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
            }
        }
    }
}

// Inicializar base de datos
async function initializeDatabase() {
    try {
        // Asegurar que todas las propiedades existan
        if (!database.users) database.users = {};
        if (!database.settings) database.settings = initialDatabase.settings;
        if (!database.stats) database.stats = initialDatabase.stats;

        // Actualizar estadísticas
        database.stats.totalUsers = Object.keys(database.users).length;
        database.stats.lastUpdate = new Date().toISOString();

        console.log('✅ Base de datos inicializada correctamente');
        return true;
    } catch (error) {
        console.error('❌ Error inicializando base de datos:', error.message);
        return false;
    }
}

// Cargar base de datos con fallback
async function loadDatabase() {
    try {
        console.log('🔄 Cargando base de datos...');

        // Intentar cargar desde JSONbin
        try {
            const agent = new https.Agent({
                keepAlive: true,
                family: 4,
                timeout: 15000,
                rejectUnauthorized: false
            });

            const response = await fetch(JSONBIN_URL_LATEST, {
                headers: {
                    'X-Master-Key': JSONBIN_MASTER_KEY,
                    'Content-Type': 'application/json'
                },
                agent: agent,
                timeout: 15000
            });

            if (response.ok) {
                const data = await response.json();
                if (data.record) {
                    database = data.record;
                    await initializeDatabase();
                    console.log('✅ Base de datos cargada desde JSONbin');
                    return database;
                }
            }
        } catch (error) {
            console.error('❌ Error cargando desde JSONbin:', error.message);
        }

        // Cargar desde archivo local
        if (fs.existsSync('./database.json')) {
            try {
                const localData = fs.readFileSync('./database.json', 'utf8');
                database = JSON.parse(localData);
                await initializeDatabase();
                console.log('✅ Base de datos cargada desde archivo local');
                return database;
            } catch (error) {
                console.error('❌ Error con archivo local:', error.message);
            }
        }

        // Crear nueva base de datos
        database = JSON.parse(JSON.stringify(initialDatabase));
        await initializeDatabase();
        await saveDatabaseLocal();
        console.log('📝 Nueva base de datos creada');
        return database;

    } catch (error) {
        console.error('❌ Error crítico cargando base de datos:', error.message);
        database = JSON.parse(JSON.stringify(initialDatabase));
        await initializeDatabase();
        return database;
    }
}

// Guardar base de datos
async function saveDatabase(data = null) {
    if (data) database = data;

    // Actualizar estadísticas antes de guardar
    await initializeDatabase();

    // Guardar localmente inmediatamente
    await saveDatabaseLocal();

    // Intentar guardar en JSONbin
    try {
        const agent = new https.Agent({
            keepAlive: true,
            family: 4,
            timeout: 15000,
            rejectUnauthorized: false
        });

        const response = await fetch(JSONBIN_URL, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                'X-Master-Key': JSONBIN_MASTER_KEY
            },
            agent: agent,
            timeout: 15000,
            body: JSON.stringify(database)
        });

        if (response.ok) {
            console.log('✅ Base de datos guardada en JSONbin');
        } else {
            throw new Error(`HTTP ${response.status}`);
        }
    } catch (error) {
        console.error('❌ Error guardando en JSONbin:', error.message);
        console.log('📁 Datos guardados localmente');
    }
}

// Guardar localmente
async function saveDatabaseLocal() {
    try {
        fs.writeFileSync('./database.json', JSON.stringify(database, null, 2));
        console.log('💾 Base de datos guardada localmente');
    } catch (error) {
        console.error('❌ Error guardando localmente:', error.message);
    }
}

// Función de reconexión mejorada
async function reconnectBot() {
    if (isPolling) return;

    reconnectAttempts++;

    if (reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
        console.error('❌ Máximo número de intentos de reconexión alcanzado');
        console.log('🔄 Reiniciando bot en 1 minuto...');
        setTimeout(() => {
            reconnectAttempts = 0;
            startBot();
        }, 60000);
        return;
    }

    const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 30000);
    console.log(`🔄 Intentando reconectar en ${delay/1000} segundos... (intento ${reconnectAttempts})`);

    setTimeout(async () => {
        try {
            if (isPolling) {
                await bot.stopPolling();
                isPolling = false;
            }

            await new Promise(resolve => setTimeout(resolve, 2000));
            await bot.startPolling();
            isPolling = true;
            console.log('✅ Bot reconectado exitosamente');
            reconnectAttempts = 0;
        } catch (error) {
            console.error('❌ Error al reconectar:', error.message);
            reconnectBot();
        }
    }, delay);
}

// Calcular crecimiento de inversión
function calculateInvestmentGrowth(investment) {
    const now = new Date().getTime();
    const startTime = new Date(investment.startDate).getTime();
    const elapsed = now - startTime;
    const duration = database.settings.investmentDuration * 60 * 60 * 1000;

    if (elapsed >= duration) return database.settings.profitRate;

    const progress = elapsed / duration;
    const growthPercentage = (database.settings.profitRate - 1) * 100 * (1 - Math.pow(0.5, progress * 2));
    return 1 + (growthPercentage / 100);
}

// Enviar notificaciones de inversiones - SISTEMA CORREGIDO
async function sendInvestmentNotifications() {
    try {
        console.log('🔍 Verificando notificaciones...');
        let notificationsSent = 0;
        const now = Date.now();
        let needsSaving = false;

        for (const [userId, user] of Object.entries(database.users)) {
            if (!user.investments || user.investments.length === 0) continue;
            if (!user.telegramId) continue;

            user.investments.forEach((investment, index) => {
                const startTime = new Date(investment.startDate).getTime();
                const elapsed = Date.now() - startTime;
                const hoursElapsed = elapsed / (1000 * 60 * 60);
                const isCompleted = hoursElapsed >= database.settings.investmentDuration;

                // Asegurar que el objeto de notificaciones exista
                if (!investment.notifications) {
                    investment.notifications = {
                        purchase: false,    // Notificación de compra
                        twoHours: false,    // Notificación a las 2 horas
                        completed: false    // Notificación de finalización
                    };
                    needsSaving = true;
                }

                // Crear clave única para esta notificación
                const notificationKey = `${userId}_${investment.id}`;
                const lastSentTime = sentNotifications.get(notificationKey) || 0;

                // NOTIFICACIÓN DE COMPRA (solo una vez, inmediatamente después de crear)
                if (!investment.notifications.purchase && user.telegramId) {
                    const message = `🎉 *¡Nueva inversión creada!*\n\n` +
                                  `Has creado una nueva inversión con un monto de *${investment.amount} Bs.*\n\n` +
                                  `*Detalles:*\n` +
                                  `• Monto: ${investment.amount} Bs.\n` +
                                  `• Retorno máximo: +3258%\n` +
                                  `• Duración: 4 horas\n` +
                                  `• Número: #${index + 1}\n\n` +
                                  `📊 *Próximas notificaciones:*\n` +
                                  `• En 2 horas: ¡Crecimiento +1200%!\n` +
                                  `• En 4 horas: ¡Máximo rendimiento alcanzado!\n\n` +
                                  `¡Tu dinero está creciendo! 🚀`;

                    sendMessageToUser(user.telegramId, message);
                    console.log(`✅ Notificación de COMPRA enviada a ${user.name}`);

                    investment.notifications.purchase = true;
                    sentNotifications.set(notificationKey + '_purchase', now);
                    notificationsSent++;
                    needsSaving = true;
                }

                // NOTIFICACIÓN A LAS 2 HORAS (solo una vez, entre 2h y 2h 10min)
                if (hoursElapsed >= 2 && hoursElapsed < 2.166 &&
                    !investment.notifications.twoHours &&
                    !investment.notifications.completed &&
                    user.telegramId) {

                    const growth = calculateInvestmentGrowth(investment);
                    const growthMultiplier = (growth - 1).toFixed(1);
                    const remainingHours = (database.settings.investmentDuration - hoursElapsed).toFixed(1);

                    const message = `📈 *¡Tu inversión ha crecido ${growthMultiplier} veces!*\n\n` +
                                  `*Inversión #${index + 1}:* ${investment.amount} Bs.\n` +
                                  `*Tiempo transcurrido:* 2 horas\n` +
                                  `*Crecimiento actual:* +${((growth - 1) * 100).toFixed(0)}%\n\n` +
                                  `💹 *¡En ${remainingHours} horas obtendrás +3258%!!*\n` +
                                  `🚀 ¡Date prisa y revisa tus ganancias!\n\n` +
                                  `👉 *¡No te pierdas el máximo rendimiento!*`;

                    sendMessageToUser(user.telegramId, message);
                    console.log(`✅ Notificación de 2 HORAS enviada a ${user.name}`);

                    investment.notifications.twoHours = true;
                    sentNotifications.set(notificationKey + '_2h', now);
                    notificationsSent++;
                    needsSaving = true;
                }

                // NOTIFICACIÓN DE FINALIZACIÓN (solo una vez, cuando se completa)
                if (isCompleted &&
                    !investment.notifications.completed &&
                    user.telegramId) {

                    const totalProfit = (investment.amount * database.settings.profitRate).toFixed(2);

                    const message = `🏆 *¡INVERSIÓN COMPLETADA!*\n\n` +
                                  `*¡Has alcanzado el máximo rendimiento de +3258%!*\n\n` +
                                  `*Inversión #${index + 1}:* ${investment.amount} Bs.\n` +
                                  `*Ganancia total:* ${totalProfit} Bs.\n\n` +
                                  `💰 *¡ESCRIBE AL ADMINISTRADOR PARA RETIRAR!*\n` +
                                  `📞 Contacta al gestor de inversiones\n` +
                                  `✍️ "Escribe al administrador"\n\n` +
                                  `¡Felicidades por tu inversión exitosa! 🎊`;

                    sendMessageToUser(user.telegramId, message);
                    console.log(`✅ Notificación de FINALIZACIÓN enviada a ${user.name}`);

                    investment.notifications.completed = true;
                    sentNotifications.set(notificationKey + '_completed', now);
                    notificationsSent++;
                    needsSaving = true;
                }
            });
        }

        if (needsSaving) {
            await saveDatabase();
        }

        if (notificationsSent > 0) {
            console.log(`📨 Total de notificaciones enviadas: ${notificationsSent}`);
        }

        cleanupOldNotifications();
    } catch (error) {
        console.error('❌ Error en sistema de notificaciones:', error.message);
    }
}

// Enviar mensaje a usuario
function sendMessageToUser(chatId, message) {
    bot.sendMessage(chatId, message, { parse_mode: 'Markdown' })
        .then(() => {
            console.log(`✅ Mensaje entregado a ${chatId}`);
        })
        .catch((error) => {
            console.error(`❌ Error al enviar a ${chatId}:`, error.message);
        });
}

// Limpiar notificaciones antiguas (más de 24 horas)
function cleanupOldNotifications() {
    const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
    let cleaned = 0;

    for (const [key, timestamp] of sentNotifications.entries()) {
        if (timestamp < oneDayAgo) {
            sentNotifications.delete(key);
            cleaned++;
        }
    }

    if (cleaned > 0) {
        console.log(`🧹 Limpiadas ${cleaned} notificaciones antiguas`);
    }
}

// =============== COMANDOS DEL BOT ===============

// Comando /start
bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    const username = msg.from.username || msg.from.first_name || 'Inversor';
    const userId = msg.from.id.toString();

    console.log(`👋 Nuevo usuario: ${username} (ID: ${chatId})`);

    try {
        // Asegurar que la base de datos esté inicializada
        await initializeDatabase();

        // Verificar si ya existe
        let user = database.users[userId];

        if (user) {
            user.name = username;
            user.telegramId = chatId;
            await saveDatabase();

            const welcomeBackMessage = `👋 *¡Bienvenido de vuelta, ${username}!*\n\n` +
                                      `Tu cuenta ya está conectada a este Telegram.\n\n` +
                                      `Usa /miperfil para ver información de tu perfil.\n` +
                                      `Usa /misinversiones para ver tus inversiones.\n\n` +
                                      `*Tu Telegram ID:* ${chatId}`;

            bot.sendMessage(chatId, welcomeBackMessage, { parse_mode: 'Markdown' });
            return;
        }

        // Crear nuevo usuario
        user = {
            id: userId,
            name: username,
            telegramId: chatId,
            balance: 0,
            investments: [],
            createdAt: new Date().toISOString(),
            isAdmin: chatId === ADMIN_ID
        };

        database.users[userId] = user;
        database.stats.totalUsers++;
        await saveDatabase();

        const welcomeMessage = `👋 ¡Hola ${username}!\n\n` +
                              `Bienvenido al *Bot de Notificaciones de Inversiones Bolivia* 🇧🇴\n\n` +
                              `*🚀 ¿Qué hace este bot?*\n` +
                              `• Te envía notificaciones cuando creas inversiones\n` +
                              `• Te avisa cuando tus inversiones crecen (+1200% en 2h)\n` +
                              `• Te notifica cuando completas inversiones (+3258% en 4h)\n` +
                              `• Recordatorios para retirar tus ganancias\n\n` +
                              `*🔗 Para conectar tu cuenta:*\n` +
                              `1. Ve a la plataforma de Inversiones Bolivia\n` +
                              `2. Haz clic en "Ingresar con Telegram"\n` +
                              `3. ¡Listo! Recibirás notificaciones automáticas\n\n` +
                              `*📊 Comandos disponibles:*\n` +
                              `/misinversiones - Ver mis inversiones activas\n` +
                              `/miperfil - Ver información de mi perfil\n` +
                              `/soporte - Contactar al administrador\n` +
                              `/ayuda - Ver todos los comandos\n\n` +
                              `*Tu Telegram ID:* ${chatId}\n\n` +
                              `💎 *¡Tu éxito financiero es nuestra prioridad!*`;

        bot.sendMessage(chatId, welcomeMessage, { parse_mode: 'Markdown' });

        // Notificar al admin
        if (chatId !== ADMIN_ID) {
            bot.sendMessage(ADMIN_ID, `👤 Nuevo usuario registrado:\n\nNombre: ${username}\nID: ${chatId}\nTotal usuarios: ${database.stats.totalUsers}`);
        }
    } catch (error) {
        console.error('❌ Error en /start:', error.message);
        bot.sendMessage(chatId, '❌ Error al procesar tu solicitud. Por favor intenta nuevamente.');
    }
});

// Comando /misinversiones
bot.onText(/\/misinversiones/, async (msg) => {
    const chatId = msg.chat.id;
    const username = msg.from.username || msg.from.first_name || 'Usuario';
    const userId = msg.from.id.toString();

    try {
        await initializeDatabase();
        const user = database.users[userId];

        if (!user) {
            const notConnectedMessage = `🔗 *Tu cuenta no está conectada*\n\n` +
                                      `Para ver tus inversiones necesitas:\n\n` +
                                      `1. Ve a la plataforma de Inversiones Bolivia\n` +
                                      `2. Haz clic en "Ingresar con Telegram"\n` +
                                      `3. ¡Listo! Podrás ver tus inversiones aquí\n\n` +
                                      `💎 *Sin conexión aún recibirás:*\n` +
                                      `• Notificaciones cuando conectes tu cuenta\n` +
                                      `• Acceso a soporte 24/7\n` +
                                      `• Asesoramiento personalizado`;

            bot.sendMessage(chatId, notConnectedMessage, { parse_mode: 'Markdown' });
            return;
        }

        if (!user.investments || user.investments.length === 0) {
            const noInvestmentsMessage = `📭 *No tienes inversiones activas*\n\n` +
                                       `¡Es el momento perfecto para comenzar!\n\n` +
                                       `✨ *Beneficios de invertir con nosotros:*\n` +
                                       `• Retorno máximo: *+${(database.settings.profitRate - 1) * 100}%*\n` +
                                       `• Duración: solo *${database.settings.investmentDuration} horas*\n` +
                                       `• Crecimiento progresivo\n` +
                                       `• Seguro y confiable\n\n` +
                                       `💎 *Ejemplo de inversión:*\n` +
                                       `Inversión: *100 Bs.*\n` +
                                       `Ganancia: *${(100 * (database.settings.profitRate - 1)).toFixed(2)} Bs.*\n` +
                                       `Total: *${(100 * database.settings.profitRate).toFixed(2)} Bs.*\n\n` +
                                       `🚀 *¡Tu futuro financiero te espera!*`;

            bot.sendMessage(chatId, noInvestmentsMessage, { parse_mode: 'Markdown' });
            return;
        }

        let message = `📈 *TUS INVERSIONES ACTIVAS*\n\n`;
        let totalInvested = 0;
        let totalCurrentProfit = 0;
        let activeInvestments = 0;

        user.investments.forEach((investment, index) => {
            const growth = calculateInvestmentGrowth(investment);
            const startDate = new Date(investment.startDate);
            const hoursElapsed = (new Date() - startDate) / (1000 * 60 * 60);
            const isCompleted = hoursElapsed >= database.settings.investmentDuration;

            const currentProfit = investment.amount * (growth - 1);
            const profitBs = currentProfit.toFixed(2);
            const growthPercent = ((growth - 1) * 100).toFixed(2);

            totalInvested += investment.amount;
            totalCurrentProfit += currentProfit;
            if (!isCompleted) activeInvestments++;

            message += `*🏦 Inversión #${index + 1}*\n`;
            message += `💰 *Monto:* ${investment.amount} Bs.\n`;
            message += `📅 *Iniciada:* ${startDate.toLocaleDateString('es-ES')} ${startDate.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })}\n`;
            message += `📊 *Crecimiento:* +${growthPercent}%\n`;
            message += `💵 *Ganancia actual:* ${profitBs} Bs.\n`;

            if (isCompleted) {
                message += `✅ *¡COMPLETADA! (+${(database.settings.profitRate - 1) * 100}%)\n`;
                message += `📞 *¡ESCRIBE AL ADMINISTRADOR PARA RETIRAR!*\n`;
                message += `✍️ "Contacta al gestor de inversiones"\n`;
            } else if (hoursElapsed >= 2) {
                const remainingHours = (database.settings.investmentDuration - hoursElapsed).toFixed(1);
                message += `🔥 *¡En crecimiento! (${growth.toFixed(1)}x)\n`;
                message += `⏰ *Tiempo restante:* ${remainingHours} horas\n`;
                message += `🎯 *¡Pronto alcanzarás +${(database.settings.profitRate - 1) * 100}%!*\n`;
            } else {
                const remainingHours = (database.settings.investmentDuration - hoursElapsed).toFixed(1);
                message += `⏳ *En progreso...*\n`;
                message += `⏰ *Tiempo restante:* ${remainingHours} horas\n`;
                message += `🚀 *¡Tu inversión está creciendo!*\n`;
            }

            message += `\n`;
        });

        // Agregar estadísticas generales
        message += `📊 *ESTADÍSTICAS GENERALES*\n`;
        message += `📈 *Inversiones activas:* ${activeInvestments}\n`;
        message += `💰 *Total invertido:* ${totalInvested.toFixed(2)} Bs.\n`;
        message += `💵 *Ganancia total actual:* ${totalCurrentProfit.toFixed(2)} Bs.\n`;

        if (totalInvested > 0) {
            const totalReturn = (totalCurrentProfit / totalInvested * 100).toFixed(2);
            message += `📈 *Retorno total:* +${totalReturn}%\n\n`;
        } else {
            message += `\n`;
        }

        if (activeInvestments > 0) {
            message += `🎯 *¡Sigue así! Tus inversiones están generando ganancias.*\n`;
        }

        message += `💡 *Consejo:* Revisa frecuentemente para ver el progreso de tus inversiones.`;

        bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
        console.log(`✅ Inversiones enviadas a ${user.name}`);
    } catch (error) {
        console.error('❌ Error en /misinversiones:', error.message);
        bot.sendMessage(chatId, '❌ Error al cargar tus inversiones. Intenta más tarde.');
    }
});

// Comando /miperfil
bot.onText(/\/miperfil/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id.toString();

    try {
        await initializeDatabase();
        const user = database.users[userId];

        if (!user) {
            const notConnectedMessage = `🔗 *Tu cuenta no está conectada*\n\n` +
                                      `*Tu Telegram ID:* ${chatId}\n\n` +
                                      `*Para conectar tu cuenta:*\n` +
                                      `1. Accede a la plataforma de Inversiones Bolivia\n` +
                                      `2. Haz clic en "Ingresar con Telegram"\n` +
                                      `3. ¡Listo! Recibirás notificaciones automáticas\n\n` +
                                      `💎 *Beneficios al conectar:*\n` +
                                      `• Notificaciones en tiempo real\n` +
                                      `• Seguimiento de inversiones\n` +
                                      `• Recordatorios importantes\n` +
                                      `• Soporte prioritario`;

            bot.sendMessage(chatId, notConnectedMessage, { parse_mode: 'Markdown' });
            return;
        }

        const joinDate = new Date(user.createdAt);
        const totalInvestments = user.investments ? user.investments.length : 0;

        let totalProfit = 0;
        if (user.investments) {
            user.investments.forEach(investment => {
                const growth = calculateInvestmentGrowth(investment);
                totalProfit += investment.amount * (growth - 1);
            });
        }

        const totalBalance = user.balance + totalProfit;

        const profileMessage = `👤 *INFORMACIÓN DE TU PERFIL*\n\n` +
                             `*🏷️ Nombre de usuario:* ${user.name}\n` +
                             `*📅 Miembro desde:* ${joinDate.toLocaleDateString('es-ES')}\n` +
                             `*🔗 Telegram ID:* ${user.telegramId}\n` +
                             `*👑 Tipo de cuenta:* ${user.isAdmin ? 'Administrador 👑' : 'Usuario Estándar'}\n\n` +

                             `💰 *ESTADO FINANCIERO*\n` +
                             `*💵 Saldo disponible:* ${user.balance.toFixed(2)} Bs.\n` +
                             `*📈 Inversiones activas:* ${totalInvestments}\n` +
                             `*💎 Ganancias en curso:* ${totalProfit.toFixed(2)} Bs.\n` +
                             `*🏦 Balance total:* ${totalBalance.toFixed(2)} Bs.\n\n`;

        let investmentStats = '';
        if (user.investments && user.investments.length > 0) {
            let completedInvestments = 0;
            let activeInvestments = 0;
            let totalInvestedAmount = 0;

            user.investments.forEach(investment => {
                totalInvestedAmount += investment.amount;
                const hoursElapsed = (new Date() - new Date(investment.startDate)) / (1000 * 60 * 60);
                if (hoursElapsed >= database.settings.investmentDuration) {
                    completedInvestments++;
                } else {
                    activeInvestments++;
                }
            });

            investmentStats = `📊 *ESTADÍSTICAS DE INVERSIONES*\n` +
                             `*✅ Completadas:* ${completedInvestments}\n` +
                             `*⏳ En progreso:* ${activeInvestments}\n` +
                             `*💰 Total invertido:* ${totalInvestedAmount.toFixed(2)} Bs.\n\n`;
        }

        const adviceMessage = `💡 *RECOMENDACIONES:*\n`;

        if (user.balance >= database.settings.minInvestment && (!user.investments || user.investments.length === 0)) {
            adviceMessage += `🎯 *¡Tienes saldo para invertir!*\n`;
            adviceMessage += `Puedes comenzar con solo ${database.settings.minInvestment} Bs. y obtener +${(database.settings.profitRate - 1) * 100}% en ${database.settings.investmentDuration} horas.\n\n`;
        } else if (user.balance < database.settings.minInvestment && (!user.investments || user.investments.length === 0)) {
            adviceMessage += `💸 *¡Necesitas fondos!*\n`;
            adviceMessage += `Tu saldo es inferior al mínimo requerido (${database.settings.minInvestment} Bs.).\n\n`;
        }

        if (user.investments && user.investments.length > 0) {
            adviceMessage += `📈 *¡Tus inversiones están activas!*\n`;
            adviceMessage += `Recibirás notificaciones cuando:\n`;
            adviceMessage += `• Crezcan +1200% (2 horas)\n`;
            adviceMessage += `• Alcanzen +${(database.settings.profitRate - 1) * 100}% (${database.settings.investmentDuration} horas)\n\n`;
        }

        adviceMessage += `🔒 *Tu información está segura con nosotros*\n\n` +
                        `🚀 *¡Sigue creciendo tu patrimonio!*`;

        const fullMessage = profileMessage + (investmentStats || '') + adviceMessage;
        bot.sendMessage(chatId, fullMessage, { parse_mode: 'Markdown' });
    } catch (error) {
        console.error('❌ Error en /miperfil:', error.message);
        bot.sendMessage(chatId, '❌ Error al cargar tu perfil. Intenta más tarde.');
    }
});

// Comando /soporte
bot.onText(/\/soporte/, (msg) => {
    const chatId = msg.chat.id;

    const supportMessage = `📞 *SOPORTE Y CONTACTO*\n\n` +
                          `¿Necesitas ayuda? ¡Estamos aquí para ti!\n\n` +
                          `*🕒 Horario de atención:*\n` +
                          `• Lunes a Domingo: 24/7\n` +
                          `• Respuesta en menos de 1 hora\n\n` +
                          `*❓ Motivos para contactar:*\n` +
                          `• Dudas sobre inversiones\n` +
                          `• Problemas con depósitos\n` +
                          `• Solicitudes de retiro\n` +
                          `• Consultas generales\n` +
                          `• Reportar problemas técnicos\n\n` +
                          `*💡 Antes de contactar:*\n` +
                          `1. Revisa /ayuda para respuestas rápidas\n` +
                          `2. Ten a mano tu nombre de usuario\n` +
                          `3. Si es sobre un pago, ten el comprobante\n\n` +
                          `*🚀 Retiros de inversiones:*\n` +
                          `Para retirar ganancias de inversiones completadas:\n` +
                          `1. Contacta al administrador\n` +
                          `2. Proporciona tu usuario\n` +
                          `3. Especifica la inversión a retirar\n` +
                          `4. Recibirás tus fundos rápidamente\n\n` +
                          `*🔒 Seguridad:*\n` +
                          `• Nunca compartas tu contraseña\n` +
                          `• Solo contacta al administrador oficial\n` +
                          `• Desconfía de personas que se hagan pasar por nosotros\n\n` +
                          `*❤️ ¡Estamos aquí para ayudarte a tener éxito!*`;

    bot.sendMessage(chatId, supportMessage, { parse_mode: 'Markdown' });
});

// Comando /ayuda
bot.onText(/\/ayuda/, (msg) => {
    const chatId = msg.chat.id;

    const helpMessage = `❓ *CENTRO DE AYUDA*\n\n` +
                       `*📋 Comandos disponibles:*\n` +
                       `/start - Mensaje de bienvenida\n` +
                       `/misinversiones - Ver mis inversiones activas\n` +
                       `/miperfil - Ver información de mi perfil\n` +
                       `/soporte - Contactar al administrador\n` +
                       `/ayuda - Ver este mensaje de ayuda\n\n` +
                       `*💎 Acerca de las notificaciones:*\n\n` +
                       `*¿Qué notificaciones recibiré?*\n` +
                       `• Cuando crees una nueva inversión (1 vez)\n` +
                       `• Cuando tu inversión crezca +1200% (2 horas, 1 vez)\n` +
                       `• Cuando alcances +${(database.settings.profitRate - 1) * 100}% (4 horas, 1 vez)\n\n` +
                       `*¿Cómo conectar mi cuenta?*\n` +
                       `1. Ve a la plataforma web\n` +
                       `2. Haz clic en "Ingresar con Telegram"\n` +
                       `3. ¡Listo! Recibirás notificaciones automáticas\n\n` +
                       `*¿No recibes notificaciones?*\n` +
                       `1. Verifica que tu cuenta esté conectada\n` +
                       `2. Asegúrate de tener inversiones activas\n` +
                       `3. Contacta a soporte si el problema persiste\n\n` +
                       `*📈 Sobre las inversiones:*\n` +
                       `• Retorno máximo: +${(database.settings.profitRate - 1) * 100}%\n` +
                       `• Duración: ${database.settings.investmentDuration} horas\n` +
                       `• Mínimo: ${database.settings.minInvestment} Bs.\n` +
                       `• Crecimiento progresivo\n\n` +
                       `*🔒 Seguridad:*\n` +
                       `• Tu Telegram ID solo se usa para notificaciones\n` +
                       `• Nunca pedimos contraseñas por aquí\n` +
                       `• Las transacciones solo en la plataforma web\n\n` +
                       `*📞 ¿Necesitas más ayuda?*\n` +
                       `Usa el comando /soporte.\n\n` +
                       `*❤️ ¡Tu éxito financiero es nuestra prioridad!*`;

    bot.sendMessage(chatId, helpMessage, { parse_mode: 'Markdown' });
});

// =============== COMANDOS DE ADMINISTRACIÓN ===============

// Comando /admin - Panel de administración
bot.onText(/\/admin/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id.toString();

    // Verificar si es admin
    if (chatId !== ADMIN_ID) {
        bot.sendMessage(chatId, '❌ No tienes permisos de administrador.');
        return;
    }

    try {
        await initializeDatabase();

        // Contar estadísticas
        let totalInvested = 0;
        let totalUsers = Object.keys(database.users).length;
        let activeInvestments = 0;

        for (const user of Object.values(database.users)) {
            if (user.investments) {
                user.investments.forEach(investment => {
                    totalInvested += investment.amount;
                    const hoursElapsed = (new Date() - new Date(investment.startDate)) / (1000 * 60 * 60);
                    if (hoursElapsed < database.settings.investmentDuration) {
                        activeInvestments++;
                    }
                });
            }
        }

        const adminMessage = `👑 *PANEL DE ADMINISTRACIÓN*\n\n` +
                            `📊 *Estadísticas Generales:*\n` +
                            `👥 Total usuarios: ${totalUsers}\n` +
                            `💰 Total invertido: ${totalInvested.toFixed(2)} Bs.\n` +
                            `📈 Inversiones activas: ${activeInvestments}\n\n` +

                            `⚙️ *Comandos de Admin:*\n` +
                            `/adduser <telegram_id> <nombre> - Agregar usuario\n` +
                            `/addbalance <user_id> <monto> - Agregar saldo\n` +
                            `/addinvestment <user_id> <monto> - Crear inversión\n` +
                            `/listusers - Listar todos los usuarios\n` +
                            `/stats - Estadísticas detalladas\n` +
                            `/backup - Crear backup de la base de datos\n\n` +

                            `🔧 *Configuración:*\n` +
                            `Mínimo inversión: ${database.settings.minInvestment} Bs.\n` +
                            `Máximo inversión: ${database.settings.maxInvestment} Bs.\n` +
                            `Tasa de ganancia: +${(database.settings.profitRate - 1) * 100}%\n` +
                            `Duración: ${database.settings.investmentDuration} horas\n\n` +

                            `💡 *Usa /stats para más detalles*`;

        bot.sendMessage(chatId, adminMessage, { parse_mode: 'Markdown' });
    } catch (error) {
        console.error('❌ Error en /admin:', error.message);
        bot.sendMessage(chatId, '❌ Error al cargar el panel de administración.');
    }
});

// Comando /adduser
bot.onText(/\/adduser (.+) (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;

    if (chatId !== ADMIN_ID) {
        bot.sendMessage(chatId, '❌ No tienes permisos de administrador.');
        return;
    }

    try {
        await initializeDatabase();

        const telegramId = match[1];
        const name = match[2];

        const newUser = {
            id: telegramId,
            name: name,
            telegramId: parseInt(telegramId),
            balance: 0,
            investments: [],
            createdAt: new Date().toISOString(),
            isAdmin: false
        };

        database.users[telegramId] = newUser;
        database.stats.totalUsers++;
        await saveDatabase();

        bot.sendMessage(chatId, `✅ Usuario agregado:\n\nID: ${telegramId}\nNombre: ${name}`, { parse_mode: 'Markdown' });
    } catch (error) {
        console.error('❌ Error en /adduser:', error.message);
        bot.sendMessage(chatId, '❌ Error al agregar usuario.');
    }
});

// Comando /addbalance
bot.onText(/\/addbalance (.+) (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;

    if (chatId !== ADMIN_ID) {
        bot.sendMessage(chatId, '❌ No tienes permisos de administrador.');
        return;
    }

    try {
        await initializeDatabase();

        const userId = match[1];
        const amount = parseFloat(match[2]);

        if (!database.users[userId]) {
            bot.sendMessage(chatId, '❌ Usuario no encontrado.');
            return;
        }

        database.users[userId].balance += amount;
        await saveDatabase();

        bot.sendMessage(chatId, `✅ Saldo agregado:\n\nUsuario: ${database.users[userId].name}\nMonto: ${amount} Bs.\nNuevo saldo: ${database.users[userId].balance} Bs.`, { parse_mode: 'Markdown' });
    } catch (error) {
        console.error('❌ Error en /addbalance:', error.message);
        bot.sendMessage(chatId, '❌ Error al agregar saldo.');
    }
});

// Comando /addinvestment
bot.onText(/\/addinvestment (.+) (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;

    if (chatId !== ADMIN_ID) {
        bot.sendMessage(chatId, '❌ No tienes permisos de administrador.');
        return;
    }

    try {
        await initializeDatabase();

        const userId = match[1];
        const amount = parseFloat(match[2]);

        if (!database.users[userId]) {
            bot.sendMessage(chatId, '❌ Usuario no encontrado.');
            return;
        }

        const user = database.users[userId];

        const investment = {
            id: Date.now().toString(),
            amount: amount,
            startDate: new Date().toISOString(),
            status: 'active',
            notifications: {
                purchase: false,
                twoHours: false,
                completed: false
            }
        };

        if (!user.investments) user.investments = [];
        user.investments.push(investment);

        await saveDatabase();

        // Notificar al usuario (solo una vez)
        if (user.telegramId) {
            const notification = `💰 *¡Nueva inversión creada por el administrador!*\n\n` +
                               `Monto: ${amount} Bs.\n` +
                               `Duración: ${database.settings.investmentDuration} horas\n` +
                               `Ganancia esperada: +${(amount * (database.settings.profitRate - 1)).toFixed(2)} Bs.\n\n` +
                               `🚀 ¡Tu dinero está trabajando para ti!`;

            bot.sendMessage(user.telegramId, notification, { parse_mode: 'Markdown' });
        }

        bot.sendMessage(chatId, `✅ Inversión creada:\n\nUsuario: ${user.name}\nMonto: ${amount} Bs.`, { parse_mode: 'Markdown' });
    } catch (error) {
        console.error('❌ Error en /addinvestment:', error.message);
        bot.sendMessage(chatId, '❌ Error al crear inversión.');
    }
});

// Comando /listusers
bot.onText(/\/listusers/, async (msg) => {
    const chatId = msg.chat.id;

    if (chatId !== ADMIN_ID) {
        bot.sendMessage(chatId, '❌ No tienes permisos de administrador.');
        return;
    }

    try {
        await initializeDatabase();

        let message = `👥 *LISTA DE USUARIOS*\n\n`;

        for (const [userId, user] of Object.entries(database.users)) {
            const investmentsCount = user.investments ? user.investments.length : 0;
            message += `👤 ${user.name}\n`;
            message += `ID: ${userId}\n`;
            message += `Telegram: ${user.telegramId || 'No conectado'}\n`;
            message += `Saldo: ${user.balance.toFixed(2)} Bs.\n`;
            message += `Inversiones: ${investmentsCount}\n`;
            message += `Admin: ${user.isAdmin ? 'Sí' : 'No'}\n\n`;
        }

        bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
    } catch (error) {
        console.error('❌ Error en /listusers:', error.message);
        bot.sendMessage(chatId, '❌ Error al listar usuarios.');
    }
});

// Comando /stats
bot.onText(/\/stats/, async (msg) => {
    const chatId = msg.chat.id;

    if (chatId !== ADMIN_ID) {
        bot.sendMessage(chatId, '❌ No tienes permisos de administrador.');
        return;
    }

    try {
        await initializeDatabase();

        let totalInvested = 0;
        let totalProfits = 0;
        let activeInvestments = 0;
        let completedInvestments = 0;

        for (const user of Object.values(database.users)) {
            if (user.investments) {
                user.investments.forEach(investment => {
                    totalInvested += investment.amount;
                    const growth = calculateInvestmentGrowth(investment);
                    totalProfits += investment.amount * (growth - 1);

                    const hoursElapsed = (new Date() - new Date(investment.startDate)) / (1000 * 60 * 60);
                    if (hoursElapsed >= database.settings.investmentDuration) {
                        completedInvestments++;
                    } else {
                        activeInvestments++;
                    }
                });
            }
        }

        const statsMessage = `📊 *ESTADÍSTICAS DETALLADAS*\n\n` +
                           `👥 *Usuarios:*\n` +
                           `Total: ${Object.keys(database.users).length}\n\n` +

                           `💰 *Inversiones:*\n` +
                           `Total invertido: ${totalInvested.toFixed(2)} Bs.\n` +
                           `Ganancias generadas: ${totalProfits.toFixed(2)} Bs.\n` +
                           `Activas: ${activeInvestments}\n` +
                           `Completadas: ${completedInvestments}\n\n` +

                           `📈 *Rendimiento:*\n` +
                           `Tasa de ganancia: +${(database.settings.profitRate - 1) * 100}%\n` +
                           `Duración: ${database.settings.investmentDuration} horas\n` +
                           `ROI promedio: ${totalInvested > 0 ? ((totalProfits / totalInvested) * 100).toFixed(2) : 0}%\n\n` +

                           `⏰ *Sistema:*\n` +
                           `Notificaciones enviadas: ${sentNotifications.size}\n` +
                           `Última actualización: ${new Date().toLocaleString('es-ES')}`;

        bot.sendMessage(chatId, statsMessage, { parse_mode: 'Markdown' });
    } catch (error) {
        console.error('❌ Error en /stats:', error.message);
        bot.sendMessage(chatId, '❌ Error al cargar estadísticas.');
    }
});

// Comando /backup
bot.onText(/\/backup/, async (msg) => {
    const chatId = msg.chat.id;

    if (chatId !== ADMIN_ID) {
        bot.sendMessage(chatId, '❌ No tienes permisos de administrador.');
        return;
    }

    try {
        await initializeDatabase();

        const backupName = `backup_${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
        const backupPath = `./backups/${backupName}`;

        // Crear directorio de backups si no existe
        if (!fs.existsSync('./backups')) {
            fs.mkdirSync('./backups');
        }

        fs.writeFileSync(backupPath, JSON.stringify(database, null, 2));

        bot.sendMessage(chatId, `✅ Backup creado:\n\nNombre: ${backupName}\nRuta: ${backupPath}\n\nTamaño: ${(fs.statSync(backupPath).size / 1024).toFixed(2)} KB`);
    } catch (error) {
        console.error('❌ Error en /backup:', error.message);
        bot.sendMessage(chatId, '❌ Error al crear backup.');
    }
});

// Manejo de mensajes de texto
bot.on('message', (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;
    const username = msg.from.username || msg.from.first_name || 'Usuario';

    // Ignorar comandos
    if (text && text.startsWith('/')) return;

    console.log(`💬 Mensaje de ${username}: "${text}"`);

    // Respuestas automáticas
    if (text && text.toLowerCase().includes('hola')) {
        const response = `¡Hola ${username}! Soy el bot de notificaciones de *Inversiones Bolivia* 🇧🇴\n\n` +
                        `Usa /start para ver cómo conectar tu cuenta y /ayuda para ver todos los comandos.\n\n` +
                        `*Tu Telegram ID:* ${chatId}`;

        bot.sendMessage(chatId, response, { parse_mode: 'Markdown' });
        return;
    }

    if (text && (text.toLowerCase().includes('invertir') || text.toLowerCase().includes('ganancia'))) {
        const response = `💎 *Información sobre inversiones:*\n\n` +
                        `En nuestra plataforma ofrecemos retornos de hasta *+${(database.settings.profitRate - 1) * 100}%* en solo *${database.settings.investmentDuration} horas*.\n\n` +
                        `Para invertir debes:\n` +
                        `1. Acceder a nuestra plataforma web\n` +
                        `2. Crear una cuenta o iniciar sesión\n` +
                        `3. Hacer clic en "Invertir Ahora"\n\n` +
                        `Usa /soporte para consultas específicas.`;

        bot.sendMessage(chatId, response, { parse_mode: 'Markdown' });
        return;
    }

    // Respuesta por defecto
    if (text && text.trim().length > 0) {
        const response = `🤖 *Bot de Notificaciones*\n\n` +
                        `He recibido tu mensaje. Para una mejor atención:\n\n` +
                        `*¿Quieres conectar tu cuenta?*\n` +
                        `Tu Telegram ID: ${chatId}\n\n` +
                        `*Comandos principales:*\n` +
                        `/start - Cómo conectar tu cuenta\n` +
                        `/miperfil - Ver tu información\n` +
                        `/soporte - Contactar al administrador\n` +
                        `/ayuda - Ver ayuda completa\n\n` +
                        `O escribe "hola" para comenzar.`;

        bot.sendMessage(chatId, response, { parse_mode: 'Markdown' });
    }
});

// Manejo de errores
bot.on('polling_error', (error) => {
    console.error('❌ Error de polling:', error.message);

    if (error.message.includes('EFATAL') || error.message.includes('ETELEGRAM') || error.message.includes('ECONNRESET')) {
        console.log('⚠️ Error crítico detectado, intentando recuperar...');
        isPolling = false;
        reconnectBot();
    }
});

bot.on('webhook_error', (error) => {
    console.error('❌ Error de webhook:', error.message);
});

process.on('unhandledRejection', (error) => {
    console.error('❌ Rechazo no manejado:', error);
});

process.on('uncaughtException', (error) => {
    console.error('❌ Excepción no capturada:', error);
});

// Función principal de inicio
async function startBot() {
    console.log('='.repeat(60));
    console.log('🤖 Bot de Inversiones Bolivia - Versión CORREGIDA');
    console.log('👑 Administrador: ' + ADMIN_ID);
    console.log('📊 Sistema de notificaciones: 1 VEZ POR EVENTO');
    console.log('🕐 Notificaciones: Compra → 2h → Finalización');
    console.log('🚫 Anti-duplicación: ACTIVADO (24h cache)');
    console.log('💾 Base de datos local y JSONbin activas');
    console.log('='.repeat(60));

    // Cargar e inicializar base de datos
    await loadDatabase();

    try {
        // Verificar token
        const botInfo = await verifyTokenWithRetry(5);

        if (botInfo) {
            console.log('✅ Token verificado exitosamente!');
            console.log(`📱 Nombre: ${botInfo.first_name}`);
            console.log(`🆔 Username: @${botInfo.username || 'N/A'}`);
            console.log('📱 Usa /start en Telegram para comenzar');
            console.log('='.repeat(60));

            // Iniciar polling
            await bot.startPolling();
            isPolling = true;
            console.log('🚀 Bot iniciado y funcionando correctamente!');

            // Notificar al admin
            bot.sendMessage(ADMIN_ID, '🤖 Bot iniciado exitosamente\n\nSistema de notificaciones CORREGIDO:\n• Compra: 1 vez\n• 2 horas: 1 vez\n• Finalización: 1 vez\n\nUsa /admin para panel');
        } else {
            throw new Error('No se pudo verificar el token');
        }
    } catch (error) {
        console.error('❌ Error crítico al iniciar el bot:', error.message);
        console.log('\n💡 SOLUCIONES SUGERIDAS:');
        console.log('1. Verifica que el token sea correcto');
        console.log('2. Revisa tu conexión a internet');
        console.log('3. Verifica si hay firewall bloqueando');
        console.log('4. Intenta ejecutar con VPN si estás en un país restringido');
        console.log('\n🔄 El bot seguirá intentando iniciar...');

        setTimeout(startBot, 30000);
    }
}

// Iniciar intervalos - SÓLO UNA VEZ CADA 30 SEGUNDOS
setInterval(sendInvestmentNotifications, 30000); // Verificar cada 30 segundos
setInterval(cleanupOldNotifications, 60 * 60 * 1000); // Limpiar cada hora
setInterval(() => saveDatabase(), 5 * 60 * 1000); // Guardar cada 5 minutos

// Iniciar el bot
startBot();