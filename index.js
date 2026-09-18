const { makeWASocket, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const pino = require('pino');
const cron = require('node-cron');
const xlsx = require('xlsx');
const moment = require('moment');
moment.locale('pt-br'); 
const fs = require('fs');
const { createCanvas, loadImage } = require('canvas');
const qrcode = require('qrcode-terminal');
const sqlite3 = require('sqlite3').verbose();
const express = require('express');

// ================= CONFIGURAÇÕES =================
const SEU_NUMERO = '5594992004241@s.whatsapp.net'; 
const ID_DO_GRUPO = '120363429143681777@g.us'; 
const ARQUIVO_PLANILHA = './banco.xlsx';
const TEMPLATE_IMAGEM = './modelo.png';
const ARQUIVO_FILA_ANIVERSARIOS = './aniversariantes_pendentes.json';
const ARQUIVO_ATENDIMENTO = './estado_atendimento.json';
const PORTA_WEBHOOK = 3000;
// =================================================

let botSocket = null; 

// =================================================
// 💾 BANCO DE DADOS UNIFICADO (MILITARES E PEDIDOS)
// =================================================
const db = new sqlite3.Database('./militares.db', (err) => {
    if (err) console.error('❌ [BD] Erro ao abrir banco de dados principal:', err);
    else {
        db.run('PRAGMA foreign_keys = ON;');
        inicializarBanco();
    }
});

const dbExec = (sql, params = []) => new Promise((resolve, reject) => db.run(sql, params, function(err) { if (err) reject(err); else resolve(this); }));
const dbGet = (sql, params = []) => new Promise((resolve, reject) => db.get(sql, params, (err, row) => { if (err) reject(err); else resolve(row); }));
const dbAll = (sql, params = []) => new Promise((resolve, reject) => db.all(sql, params, (err, rows) => { if (err) reject(err); else resolve(rows); }));

async function inicializarBanco() {
    console.log('🔄 [BD] Inicializando e checando estrutura do banco de dados...');
    await dbExec(`CREATE TABLE IF NOT EXISTS militares (
        identidade_militar TEXT PRIMARY KEY,
        posto_graduacao TEXT,
        nome_guerra TEXT,
        nome_completo TEXT,
        telefone TEXT,
        om TEXT,
        dados_planilha TEXT,
        ativo INTEGER DEFAULT 1
    )`);

    await dbExec(`CREATE TABLE IF NOT EXISTS tipos_pedido (
        id_tipo INTEGER PRIMARY KEY AUTOINCREMENT,
        nome TEXT UNIQUE NOT NULL,
        descricao TEXT,
        ativo INTEGER DEFAULT 1
    )`);

    await dbExec(`CREATE TABLE IF NOT EXISTS pedidos (
        id_pedido INTEGER PRIMARY KEY AUTOINCREMENT,
        identidade_militar TEXT NOT NULL,
        tipo_pedido TEXT NOT NULL,
        data_pedido DATETIME DEFAULT CURRENT_TIMESTAMP,
        descricao TEXT,
        quantidade INTEGER DEFAULT 1,
        valor_unitario REAL DEFAULT 0,
        valor_total REAL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'AGUARDANDO PAGAMENTO' CHECK(status IN ('PENDENTE', 'EM ANDAMENTO', 'CONCLUÍDO', 'CANCELADO', 'AGUARDANDO PAGAMENTO', 'PAGO , CONFECÇÃO EM ANDAMENTO', 'ENTREGUE')),
        observacao TEXT,
        FOREIGN KEY(identidade_militar) REFERENCES militares(identidade_militar)
    )`);

    await dbExec(`CREATE TABLE IF NOT EXISTS pedidos_aguardando_vinculo (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        telefone TEXT,
        tipo_pedido TEXT,
        posto TEXT,
        nome_guerra TEXT,
        quantidade INTEGER,
        valor_unitario REAL,
        valor_total REAL,
        comprovante TEXT,
        data_pedido DATETIME
    )`);

    await dbExec(`CREATE TABLE IF NOT EXISTS pagamentos (
        id_pagamento INTEGER PRIMARY KEY AUTOINCREMENT,
        id_pedido INTEGER NOT NULL,
        valor REAL,
        forma_pagamento TEXT,
        data_pagamento DATETIME DEFAULT CURRENT_TIMESTAMP,
        comprovante TEXT,
        status_pagamento TEXT,
        FOREIGN KEY(id_pedido) REFERENCES pedidos(id_pedido)
    )`);

    await dbExec(`CREATE TABLE IF NOT EXISTS anexos (
        id_anexo INTEGER PRIMARY KEY AUTOINCREMENT,
        id_pedido INTEGER NOT NULL,
        tipo_anexo TEXT,
        nome_arquivo TEXT,
        caminho_arquivo TEXT,
        url TEXT,
        FOREIGN KEY(id_pedido) REFERENCES pedidos(id_pedido)
    )`);

    await dbExec(`CREATE INDEX IF NOT EXISTS idx_pedidos_identidade ON pedidos(identidade_militar)`);
    await dbExec(`CREATE INDEX IF NOT EXISTS idx_pedidos_status ON pedidos(status)`);

    const tiposIniciais = [
        'Challenge Coin', 'Cartão de aniversário', 'Confecção de arte', 
        'Impressão', 'Certificado', 'Cobertura fotográfica', 
        'Divulgação no Instagram', 'Divulgação no WhatsApp', 
        'Edição de fotografia', 'Vídeo', 'Solicitação de documento', 'Outros',
        'ABRIGO MODELO 2026'
    ];
    for (let tipo of tiposIniciais) {
        await dbExec(`INSERT OR IGNORE INTO tipos_pedido (nome) VALUES (?)`, [tipo]);
    }

    console.log('✅ [BD] Banco de Dados Unificado com Sistema de Quarentena estruturado!');
}

async function pesquisarMilitarPorIdentidade(idt) {
    console.log(`🔍 [BD] Pesquisando militar por IDT: ${idt}...`);
    return await dbGet(`SELECT * FROM militares WHERE identidade_militar = ?`, [idt]);
}

async function pesquisarMilitarPorTelefone(telefone) {
    console.log(`🔍 [BD] Pesquisando militar por Telefone: ${telefone}...`);
    return await dbGet(`SELECT * FROM militares WHERE telefone = ?`, [telefone]);
}

async function listarHistoricoMilitar(idt) {
    console.log(`🔍 [BD] Puxando histórico de pedidos da IDT: ${idt}...`);
    return await dbAll(
        `SELECT m.identidade_militar, m.posto_graduacao, m.nome_guerra, m.telefone, 
                p.id_pedido, p.tipo_pedido, p.data_pedido, p.descricao, p.quantidade, 
                p.valor_unitario, p.valor_total, p.status, p.observacao
         FROM pedidos p
         INNER JOIN militares m ON p.identidade_militar = m.identidade_militar
         WHERE p.identidade_militar = ?
         ORDER BY p.data_pedido DESC`, 
         [idt]
    );
}

let estadoAdmin = null;

// === GESTÃO DO ESTADO DE ATENDIMENTO ===
function getEstadoAtendimento() {
    if (!fs.existsSync(ARQUIVO_ATENDIMENTO)) {
        return { disponivel: false, ativos: {}, fila: [], usuarios_ura: {} };
    }
    let data = JSON.parse(fs.readFileSync(ARQUIVO_ATENDIMENTO, 'utf8'));
    if (!data.usuarios_ura) data.usuarios_ura = {}; 
    return data;
}

function salvarEstadoAtendimento(estado) {
    fs.writeFileSync(ARQUIVO_ATENDIMENTO, JSON.stringify(estado, null, 2));
}

function limparImagensResiduais() {
    try {
        const arquivos = fs.readdirSync('./');
        let cont = 0;
        arquivos.forEach(arquivo => {
            if (arquivo.startsWith('aniversario_gerado_') && arquivo.endsWith('.png')) {
                fs.unlinkSync(`./${arquivo}`);
                cont++;
            }
        });
        if (cont > 0) console.log(`🧹 [SISTEMA] Limpeza concluída: ${cont} imagens deletadas.`);
    } catch (erro) {
        console.error('❌ [SISTEMA] Erro durante a faxina de imagens:', erro);
    }
}

// =================================================
// 🌐 WEBHOOK (EXPRESS) - RECEBE DO GOOGLE FORMS
// =================================================
const app = express();
app.use(express.json());

app.post('/webhook-moeda', async (req, res) => {
    try {
        console.log('\n======================================');
        console.log('📡 [WEBHOOK] NOVO POST RECEBIDO!');
        console.log('📦 [WEBHOOK] Payload:', req.body);
        
        let dataRaw = req.body.data;
        let posto = String(req.body.posto || '').trim();
        let nomeGuerra = String(req.body.nomeGuerra || '').trim();
        let telefoneForm = String(req.body.telefone || '').replace(/\D/g, '');
        let qtdTexto = String(req.body.quantidade || '1');
        let comprovante = req.body.comprovante;

        if (!nomeGuerra) {
            console.log('❌ [WEBHOOK] Erro: Nome de Guerra ausente no payload.');
            return res.status(400).send('Nome de Guerra ausente');
        }

        console.log(`🛠️ [WEBHOOK] Tratando telefone extraído do formulário: ${telefoneForm}`);
        if (telefoneForm.length >= 10 && !telefoneForm.startsWith('55')) telefoneForm = '55' + telefoneForm;
        let telefoneWhatsapp = telefoneForm ? telefoneForm + '@s.whatsapp.net' : null;
        console.log(`📞 [WEBHOOK] Telefone formatado para WhatsApp: ${telefoneWhatsapp}`);

        let dataSQL = moment(dataRaw, 'DD/MM/YYYY HH:mm:ss').isValid() ? moment(dataRaw, 'DD/MM/YYYY HH:mm:ss').format('YYYY-MM-DD HH:mm:ss') : moment().format('YYYY-MM-DD HH:mm:ss');
        let quantidadeMatch = qtdTexto.match(/\d+/);
        let quantidade = quantidadeMatch ? parseInt(quantidadeMatch[0]) : 1;
        let valorUnitario = 60.0;
        let valorTotal = quantidade * valorUnitario;

        console.log(`🔍 [WEBHOOK] Verificando se o militar já existe na base...`);
        let militarBanco = null;
        if (telefoneWhatsapp) {
            militarBanco = await dbGet(`SELECT * FROM militares WHERE telefone = ?`, [telefoneWhatsapp]);
        }
        if (!militarBanco) {
            console.log(`⚠️ [WEBHOOK] Telefone não encontrado. Tentando buscar pelo Nome de Guerra: ${nomeGuerra}...`);
            militarBanco = await dbGet(`SELECT * FROM militares WHERE UPPER(TRIM(nome_guerra)) = ?`, [nomeGuerra.toUpperCase()]);
        }

        if (!militarBanco) {
            console.log(`🛑 [WEBHOOK] Militar NÃO ENCONTRADO na base oficial.`);
            console.log(`📥 [WEBHOOK] Movendo pedido para a TABELA DE QUARENTENA (pedidos_aguardando_vinculo)...`);
            
            await dbExec(
                `INSERT INTO pedidos_aguardando_vinculo (telefone, tipo_pedido, posto, nome_guerra, quantidade, valor_unitario, valor_total, comprovante, data_pedido)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [telefoneWhatsapp, 'Challenge Coin', posto, nomeGuerra, quantidade, valorUnitario, valorTotal, comprovante, dataSQL]
            );

            if (botSocket && telefoneWhatsapp && telefoneWhatsapp.includes('@s.whatsapp.net')) {
                console.log(`📲 [WEBHOOK] Disparando alerta no WhatsApp pedindo vínculo para: ${telefoneWhatsapp}`);
                let msgAlerta = `📦 *PEDIDO RECEBIDO - S7 COMUNICAÇÃO SOCIAL*\n\n`;
                msgAlerta += `Olá, *${posto} ${nomeGuerra}*!\n`;
                msgAlerta += `Recebemos sua solicitação de *Challenge Coin* via formulário.\n\n`;
                msgAlerta += `Para consultar o status do seu pedido e emitir o recibo, *basta mandar um "Oi" por aqui, e escolher a opção 5 (Consultar Meus Pedidos).* 🇧🇷`;
                
                await botSocket.sendMessage(telefoneWhatsapp, { text: msgAlerta });
            } else {
                console.log(`⚠️ [WEBHOOK] Sem bot conectado ou telefone inválido para envio de WhatsApp.`);
            }

            console.log('✅ [WEBHOOK] Processamento encerrado (Status: Quarentena).');
            console.log('======================================\n');
            return res.status(200).send('Militar não encontrado, pedido enviado para quarentena.');
        }

        console.log(`✅ [WEBHOOK] Militar localizado na base! IDT: ${militarBanco.identidade_militar} - ${militarBanco.nome_guerra}`);
        
        let idt = militarBanco.identidade_militar;
        let telefoneOficialMilitar = militarBanco.telefone || telefoneWhatsapp;
        
        console.log(`📥 [WEBHOOK] Inserindo pedido diretamente na tabela oficial...`);
        await dbExec(
            `INSERT INTO pedidos (identidade_militar, tipo_pedido, data_pedido, descricao, quantidade, valor_unitario, valor_total, status) 
            VALUES (?, 'Challenge Coin', ?, 'Pedido via Forms Webhook', ?, ?, ?, 'AGUARDANDO PAGAMENTO')`,
            [idt, dataSQL, quantidade, valorUnitario, valorTotal]
        );
        
        const pedidoSalvo = await dbGet(`SELECT seq AS id FROM sqlite_sequence WHERE name='pedidos'`);
        const idPedido = pedidoSalvo.id;

        console.log(`💸 [WEBHOOK] Vinculando pagamento e anexos ao Pedido #${idPedido}...`);
        await dbExec(`INSERT INTO pagamentos (id_pedido, valor, forma_pagamento, status_pagamento) VALUES (?, ?, 'PIX', 'PENDENTE')`, [idPedido, valorTotal]);
        if (comprovante) {
            await dbExec(`INSERT INTO anexos (id_pedido, tipo_anexo, nome_arquivo, url) VALUES (?, 'Comprovante PIX', 'comprovante_transferencia', ?)`, [idPedido, comprovante]);
        }

        if (botSocket && telefoneOficialMilitar && telefoneOficialMilitar.includes('@s.whatsapp.net')) {
            console.log(`📲 [WEBHOOK] Disparando recibo oficial no WhatsApp: ${telefoneOficialMilitar}`);
            let msgRecibo = `📦 *NOVO PEDIDO RECEBIDO*\n\n`;
            msgRecibo += `Olá, *${militarBanco.posto_graduacao} ${militarBanco.nome_guerra}*!\n`;
            msgRecibo += `A Seção de Comunicação Social registrou a sua solicitação com sucesso.\n\n`;
            msgRecibo += `PRODUTO: *Challenge Coin*\n`;
            msgRecibo += `QUANTIDADE: ${quantidade} un.\n`;
            msgRecibo += `VALOR TOTAL: R$ ${valorTotal.toFixed(2).replace('.', ',')}\n`;
            msgRecibo += `STATUS: *AGUARDANDO PAGAMENTO*\n\n`;
            msgRecibo += `Aguarde a conferência do seu comprovante. Tudo pela Amazônia, Selva! 🇧🇷`;

            await botSocket.sendMessage(telefoneOficialMilitar, { text: msgRecibo });
        }

        console.log('✅ [WEBHOOK] Processamento encerrado (Status: Vinculado Oficialmente).');
        console.log('======================================\n');
        res.status(200).send('Processado e vinculado');
    } catch (err) {
        console.error('❌ [WEBHOOK] ERRO CRÍTICO:', err);
        res.status(500).send('Erro interno');
    }
});

app.listen(PORTA_WEBHOOK, () => {
    console.log(`🌐 [EXPRESS] Servidor Webhook rodando na porta ${PORTA_WEBHOOK}`);
});

// === INÍCIO DO SISTEMA WHATSAPP ===
async function iniciarBot() {
    console.log('🔄 [WHATSAPP] Iniciando conexão Baileys...');
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }), 
        connectTimeoutMs: 60000, 
        defaultQueryTimeoutMs: 60000,
        keepAliveIntervalMs: 10000,
        generateHighQualityLinkPreview: true
    });

    botSocket = sock; 

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
            console.log('\n📲 [WHATSAPP] Novo QR Code gerado! Escaneie:');
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error)?.output?.statusCode !== 401;
            console.log(`⚠ [WHATSAPP] Conexão fechada. Reconectando: ${shouldReconnect}`);
            if (shouldReconnect) iniciarBot();
            else console.log('❌ [WHATSAPP] Desconectado permanentemente. Apague a pasta "auth_info_baileys" e reinicie.');
        } else if (connection === 'open') {
            console.log('\n✅ [WHATSAPP] Sistema conectado com sucesso!');
            iniciarAgendamento(sock);
            limparImagensResiduais();
        }
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message) return;

        const remetenteReal = msg.key.remoteJid;
        const textoMsg = (msg.message.conversation || msg.message.extendedTextMessage?.text || '').trim();
        const comandoUpperCase = textoMsg.toUpperCase();
        
        const ehPrivado = !remetenteReal.endsWith('@g.us');

        if (!ehPrivado) {
            // Ignora grupos silenciosamente na maioria das vezes, logamos apenas para debug eventual
            return; 
        }

        console.log(`📩 [WHATSAPP] Mensagem recebida de: ${remetenteReal} | Texto: "${textoMsg.substring(0, 30)}..."`);

        if (ehPrivado) {
            
            if (msg.key.fromMe) {
                if (comandoUpperCase === '/FINALIZAR') {
                    console.log(`👑 [ADMIN] Comando /FINALIZAR acionado para ${remetenteReal}`);
                    let estado = getEstadoAtendimento();
                    if (estado.ativos[remetenteReal]) {
                        delete estado.ativos[remetenteReal]; 
                        salvarEstadoAtendimento(estado);
                        await sock.sendMessage(remetenteReal, { text: '✅ *Atendimento Finalizado.*\n\nA Comunicação Social da 23ª Bda Inf Sl agradece seu contato! Tudo pela Amazônia. Selva! 🇧🇷' });
                        console.log(`✅ [ADMIN] Atendimento de ${remetenteReal} encerrado.`);
                        if (estado.fila.length > 0) {
                            await sock.sendMessage(SEU_NUMERO, { text: `🔔 *Lembrete de Fila:* Você encerrou o atendimento, mas ainda há ${estado.fila.length} pessoa(s) na fila.\n\nDigite */ATENDER* no seu próprio chat para puxar o próximo.` });
                        }
                    }
                    return;
                }
                if (remetenteReal !== SEU_NUMERO) return; 
            }

            const ehAdminNoPainel = remetenteReal === SEU_NUMERO || remetenteReal === '41739163279551@lid';

            // ==========================================
            // 👑 FLUXO DO ADMIN (NO PRÓPRIO CHAT)
            // ==========================================
            if (ehAdminNoPainel) {
                
                if (comandoUpperCase === '/PEDIDO') {
                    console.log('👑 [ADMIN] Iniciando fluxo de atualização de status (/PEDIDO)');
                    estadoAdmin = { acao: 'pedido_aguardando_idt' };
                    await sock.sendMessage(remetenteReal, { text: '📦 *Atualização de Pedido*\n\nDigite a *Identidade Militar* do militar que você deseja atualizar o pedido (ou envie CANCELAR):' });
                    return;
                }

                if (comandoUpperCase === '/CRUZAR') {
                    console.log('👑 [ADMIN] Iniciando sincronização (/CRUZAR)');
                    await sock.sendMessage(remetenteReal, { text: '🔄 *Sincronizando planilha geral com o banco oficial...*' });

                    try {
                        let cruzadosBanco = 0;

                        if (fs.existsSync(ARQUIVO_PLANILHA)) {
                            console.log(`📄 [ADMIN] Lendo arquivo ${ARQUIVO_PLANILHA}...`);
                            const workbook = xlsx.readFile(ARQUIVO_PLANILHA, { cellDates: true });
                            const militaresPlanilha = xlsx.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]]);

                            for (let militar of militaresPlanilha) {
                                let idt = ''; let posto = ''; let nomeGuerra = ''; let nomeCompleto = ''; let telefonePlanilha = '';
                                for (let key in militar) {
                                    const k = key.toUpperCase().trim();
                                    const valor = String(militar[key]).trim();
                                    if (k === 'IDT' || k.includes('IDENTIDADE')) idt = valor;
                                    else if (!posto && (k.includes('POSTO') || k.includes('GRADUA'))) posto = valor;
                                    else if (!nomeGuerra && k.includes('GUERRA')) nomeGuerra = valor;
                                    else if (!nomeCompleto && (k.includes('NOME COMPLETO') || k === 'NOME DO MILITAR' || k === 'NOME')) nomeCompleto = valor;
                                    else if (!telefonePlanilha && (k.includes('TELEFONE') || k.includes('CELULAR') || k.includes('WHATSAPP') || k.includes('CONTATO'))) telefonePlanilha = valor;
                                }

                                if (idt) idt = idt.replace(/[^a-zA-Z0-9]/g, '');
                                if (!idt) continue;

                                const militarBanco = await pesquisarMilitarPorIdentidade(idt);
                                let telefoneWhatsapp = null;
                                
                                if (telefonePlanilha && telefonePlanilha !== 'undefined' && telefonePlanilha !== '') {
                                    let nums = telefonePlanilha.replace(/\D/g, ''); 
                                    if (nums.length >= 10) {
                                        if (!nums.startsWith('55')) nums = '55' + nums; 
                                        telefoneWhatsapp = nums + '@s.whatsapp.net';
                                    } else telefoneWhatsapp = telefonePlanilha; 
                                } else if (militarBanco && militarBanco.telefone) {
                                    telefoneWhatsapp = militarBanco.telefone;
                                }

                                const dadosJSON = JSON.stringify(militar);
                                if (militarBanco) {
                                    await dbExec(`UPDATE militares SET posto_graduacao = ?, nome_guerra = ?, nome_completo = ?, telefone = ?, dados_planilha = ? WHERE identidade_militar = ?`, [posto, nomeGuerra, nomeCompleto, telefoneWhatsapp, dadosJSON, idt]);
                                } else {
                                    await dbExec(`INSERT INTO militares (identidade_militar, posto_graduacao, nome_guerra, nome_completo, telefone, dados_planilha) VALUES (?, ?, ?, ?, ?, ?)`, [idt, posto, nomeGuerra, nomeCompleto, telefoneWhatsapp, dadosJSON]);
                                }
                                cruzadosBanco++;
                            }
                            console.log(`✅ [ADMIN] ${cruzadosBanco} militares processados do Excel.`);
                        } else {
                            console.log(`⚠ [ADMIN] Arquivo ${ARQUIVO_PLANILHA} não encontrado.`);
                        }

                        await sock.sendMessage(remetenteReal, { text: `✅ *Sincronização Concluída!*\n\n🔹 Planilha Geral: *${cruzadosBanco} cadastros processados e atualizados na base oficial.*\n` });

                    } catch (err) {
                        console.error('❌ [ADMIN] Erro na sincronização:', err);
                        await sock.sendMessage(remetenteReal, { text: `❌ *Ocorreu um erro ao sincronizar os dados:*\n${err.message}` });
                    }
                    return;
                }

                if (comandoUpperCase === '/DISPONIVEL' || comandoUpperCase === '/ONLINE') {
                    console.log('👑 [ADMIN] Mudando status para DISPONÍVEL');
                    let estado = getEstadoAtendimento();
                    estado.disponivel = true;
                    salvarEstadoAtendimento(estado);
                    let txtAdicional = estado.fila.length > 0 ? `\n\n⚠ *Atenção:* Você possui ${estado.fila.length} pessoa(s) aguardando na fila. Digite */ATENDER* para chamar o primeiro.` : '';
                    await sock.sendMessage(remetenteReal, { text: '🟢 *Status Atualizado:* Você agora está *DISPONÍVEL*.\nAs novas transferências cairão direto para você!' + txtAdicional });
                    return;
                }
                
                if (comandoUpperCase === '/INDISPONIVEL' || comandoUpperCase === '/OFFLINE') {
                    console.log('👑 [ADMIN] Mudando status para INDISPONÍVEL');
                    let estado = getEstadoAtendimento();
                    estado.disponivel = false;
                    salvarEstadoAtendimento(estado);
                    await sock.sendMessage(remetenteReal, { text: '🔴 *Status Atualizado:* Você agora está *INDISPONÍVEL*.\nNovos civis que pedirem atendimento serão jogados na fila de espera automática.' });
                    return;
                }

                if (comandoUpperCase === '/FILA') {
                    console.log('👑 [ADMIN] Solicitou visualização da FILA');
                    let estado = getEstadoAtendimento();
                    if (estado.fila.length === 0) {
                        await sock.sendMessage(remetenteReal, { text: '✅ Não há ninguém na fila de espera no momento.' });
                        return;
                    }
                    let txt = `👥 *Fila de Espera Atual (${estado.fila.length} pessoa(s)):*\n\n`;
                    estado.fila.forEach((num, idx) => {
                        txt += `${idx + 1}º - wa.me/${num.split('@')[0]}\n`;
                    });
                    txt += `\n👉 Digite */ATENDER* para chamar o primeiro da fila.`;
                    await sock.sendMessage(remetenteReal, { text: txt });
                    return;
                }

                if (comandoUpperCase === '/ATENDER' || comandoUpperCase === '/PROXIMO') {
                    console.log('👑 [ADMIN] Solicitou ATENDER próximo da fila');
                    let estado = getEstadoAtendimento();
                    if (estado.fila.length === 0) {
                        await sock.sendMessage(remetenteReal, { text: '✅ A fila de espera está vazia.' });
                        return;
                    }
                    
                    const proximo = estado.fila.shift(); 
                    estado.ativos[proximo] = true; 
                    salvarEstadoAtendimento(estado);
                    
                    await sock.sendMessage(proximo, { text: '🟢 Olá! Um de nossos militares acabou de assumir o seu atendimento.\n\nComo podemos ajudar hoje?' });
                    await sock.sendMessage(remetenteReal, { text: `✅ *Atendimento Iniciado!*\n\nO número wa.me/${proximo.split('@')[0]} foi retirado da fila.\nAbra a conversa com ele para continuar. Restam ${estado.fila.length} na fila.` });
                    return;
                }

                // ==========================================
                // 🔄 MÁQUINA DE ESTADOS DO ADMIN (EDIÇÕES E PEDIDOS)
                // ==========================================
                if (estadoAdmin) {
                    if (comandoUpperCase === 'CANCELAR') {
                        console.log('👑 [ADMIN] Abortou operação em andamento.');
                        estadoAdmin = null;
                        await sock.sendMessage(remetenteReal, { text: '❌ Operação cancelada com sucesso.' });
                        return;
                    }

                    // --- FLUXO DE ATUALIZAÇÃO DE PEDIDOS ---
                    if (estadoAdmin.acao === 'pedido_aguardando_idt') {
                        const idt = textoMsg.trim().replace(/[^a-zA-Z0-9]/g, '');
                        console.log(`👑 [ADMIN] Buscando IDT para editar pedido: ${idt}`);
                        const militar = await pesquisarMilitarPorIdentidade(idt);
                        
                        if (!militar) {
                            console.log(`❌ [ADMIN] IDT ${idt} não encontrada.`);
                            await sock.sendMessage(remetenteReal, { text: '❌ Identidade não encontrada no banco de dados.\n\nDigite novamente ou envie CANCELAR.' });
                            return;
                        }
                        
                        const pedidos = await listarHistoricoMilitar(idt);
                        if (pedidos.length === 0) {
                            console.log(`⚠️ [ADMIN] Militar encontrado, mas sem pedidos.`);
                            await sock.sendMessage(remetenteReal, { text: `✅ Militar *${militar.posto_graduacao} ${militar.nome_guerra}* encontrado.\n\nPorém, não há nenhum pedido registrado para ele no sistema. Operação cancelada.` });
                            estadoAdmin = null;
                            return;
                        }
                        
                        let txt = `📦 *Pedidos de ${militar.posto_graduacao} ${militar.nome_guerra}*\n\n`;
                        pedidos.forEach(p => {
                            let dataFormatada = moment(p.data_pedido).format('DD/MM/YYYY');
                            txt += `🆔 *ID do Pedido:* ${p.id_pedido}\n`;
                            txt += `PRODUTO: ${p.tipo_pedido} (${dataFormatada})\n`;
                            txt += `STATUS: *${p.status}*\n\n`;
                        });
                        txt += `👉 Digite apenas o *ID do Pedido* que você deseja atualizar o status (ou CANCELAR):`;
                        
                        estadoAdmin = { acao: 'pedido_aguardando_id_pedido', militar: militar };
                        await sock.sendMessage(remetenteReal, { text: txt });
                        return;
                    }

                    if (estadoAdmin.acao === 'pedido_aguardando_id_pedido') {
                        const idPedido = parseInt(textoMsg.trim());
                        console.log(`👑 [ADMIN] ID do pedido informado: ${idPedido}`);
                        if (isNaN(idPedido)) {
                            await sock.sendMessage(remetenteReal, { text: '❌ Formato inválido. Digite apenas o *número* do ID do pedido.' });
                            return;
                        }
                        
                        const pedidoBanco = await dbGet(`SELECT * FROM pedidos WHERE id_pedido = ?`, [idPedido]);
                        if (!pedidoBanco) {
                            console.log(`❌ [ADMIN] Pedido #${idPedido} não encontrado.`);
                            await sock.sendMessage(remetenteReal, { text: '❌ Pedido não encontrado no banco. Verifique o número e digite novamente.' });
                            return;
                        }
                        
                        estadoAdmin = { acao: 'pedido_aguardando_status', idPedido: idPedido };
                        
                        let txt = `📝 *Atualizando o Pedido #${idPedido}*\nProduto: ${pedidoBanco.tipo_pedido}\nStatus Atual: ${pedidoBanco.status}\n\n`;
                        txt += `Escolha o novo status:\n`;
                        txt += `*1* - AGUARDANDO PAGAMENTO\n`;
                        txt += `*2* - PAGO , CONFECÇÃO EM ANDAMENTO\n`;
                        txt += `*3* - ENTREGUE\n`;
                        txt += `*4* - CANCELADO\n\n`;
                        txt += `👉 Digite o número correspondente à opção:`;
                        
                        await sock.sendMessage(remetenteReal, { text: txt });
                        return;
                    }

                    if (estadoAdmin.acao === 'pedido_aguardando_status') {
                        const opcao = textoMsg.trim();
                        console.log(`👑 [ADMIN] Opção de novo status: ${opcao}`);
                        const statusMap = {
                            '1': 'AGUARDANDO PAGAMENTO',
                            '2': 'PAGO , CONFECÇÃO EM ANDAMENTO',
                            '3': 'ENTREGUE',
                            '4': 'CANCELADO'
                        };
                        
                        if (!statusMap[opcao]) {
                            await sock.sendMessage(remetenteReal, { text: '❌ Opção inválida. Digite 1, 2, 3 ou 4.' });
                            return;
                        }
                        
                        const novoStatus = statusMap[opcao];
                        console.log(`✅ [ADMIN] Atualizando Pedido #${estadoAdmin.idPedido} para status: ${novoStatus}`);
                        await dbExec(`UPDATE pedidos SET status = ? WHERE id_pedido = ?`, [novoStatus, estadoAdmin.idPedido]);
                        
                        await sock.sendMessage(remetenteReal, { text: `✅ *Status Atualizado com Sucesso!*\n\nO pedido #${estadoAdmin.idPedido} agora consta como: *${novoStatus}*.` });
                        estadoAdmin = null;
                        return;
                    }

                    // --- FLUXO DE EDIÇÃO DE ANIVERSARIANTES ---
                    if (estadoAdmin.acao === 'selecionando_militar') {
                        const indice = parseInt(textoMsg) - 1;
                        const pendentes = JSON.parse(fs.readFileSync(ARQUIVO_FILA_ANIVERSARIOS, 'utf8'));
                        
                        if (isNaN(indice) || indice < 0 || indice >= pendentes.length) {
                            await sock.sendMessage(remetenteReal, { text: '❌ Número inválido. Digite o número correspondente da lista ou envie *CANCELAR*.' });
                            return;
                        }
                        
                        estadoAdmin = { acao: 'esperando_novo_nome', index: indice };
                        await sock.sendMessage(remetenteReal, { text: `✏ Você selecionou o *${pendentes[indice].posto} ${pendentes[indice].nomeGuerra}*.\n\nAgora, digite o Posto e o Nome separados por um TRAÇO (-).\n**Coloque entre asteriscos a parte que ficará em NEGRITO na imagem.**\n\nExemplo: *3º Sgt - João *Silva**` });
                        return;
                    }

                    if (estadoAdmin.acao === 'esperando_novo_nome') {
                        const pendentes = JSON.parse(fs.readFileSync(ARQUIVO_FILA_ANIVERSARIOS, 'utf8'));
                        const index = estadoAdmin.index;
                        const militarAtual = pendentes[index];
                        const imagemAntiga = militarAtual.imagem; 
                        const novoTexto = textoMsg.trim();
                        
                        let novoPosto = militarAtual.posto; 
                        let textoNome = novoTexto;

                        if (novoTexto.includes('-')) {
                            const partesSeparadas = novoTexto.split('-');
                            novoPosto = partesSeparadas[0].trim();
                            textoNome = partesSeparadas.slice(1).join('-').trim();
                        } else {
                            const patentesComuns = ['SD', 'CB', 'SGT', 'SUB', 'TEN', 'CAP', 'MAJ', 'TC', 'CEL', 'GEN', 'ASP'];
                            const primeiraPalavra = novoTexto.split(' ')[0].toUpperCase();
                            
                            if (novoTexto.includes('º') || novoTexto.includes('°')) {
                                const partes = novoTexto.split(' ');
                                if (partes.length >= 3) {
                                    novoPosto = partes[0] + ' ' + partes[1];
                                    textoNome = partes.slice(2).join(' ').trim();
                                }
                            } else if (patentesComuns.includes(primeiraPalavra)) {
                                const partes = novoTexto.split(' ');
                                novoPosto = partes[0];
                                textoNome = partes.slice(1).join(' ').trim();
                            }
                        }
                        
                        let matchBold = textoNome.match(/\*(.*?)\*/);
                        let novoNomeCompleto = textoNome.replace(/\*/g, '').replace(/\s+/g, ' ').trim();
                        
                        if (!novoNomeCompleto) {
                            await sock.sendMessage(remetenteReal, { text: '❌ Formato inválido. Exemplo correto: *3º Sgt - João *Silva**' });
                            return;
                        }

                        let novoNomeGuerra = matchBold ? matchBold[1].trim() : novoNomeCompleto.split(' ').pop();

                        militarAtual.posto = novoPosto;
                        militarAtual.nomeGuerra = novoNomeGuerra;
                        militarAtual.nomeCompleto = novoNomeCompleto; 

                        const textoGrupo = `_🎉 PARABÉNS, *${novoPosto.toUpperCase()} ${novoNomeGuerra.toUpperCase()}*! 🎉_\n\n_A Companhia de Comando da 23ª Bda Inf Sl parabeniza o ${novoPosto} ${novoNomeGuerra} pelo seu aniversário, desejando muita saúde, felicidade, sucesso e realizações._\n \n_*Que este novo ciclo seja repleto de conquistas e bons momentos junto aos seus familiares e amigos.*_\n\nFeliz aniversário! Tudo pela Amazônia. Selva!🇧🇷`;
                        militarAtual.texto = textoGrupo;

                        try {
                            const novaImagemGerada = await gerarImagem(novoPosto, novoNomeCompleto, novoNomeGuerra);
                            militarAtual.imagem = novaImagemGerada;

                            pendentes[index] = militarAtual;
                            fs.writeFileSync(ARQUIVO_FILA_ANIVERSARIOS, JSON.stringify(pendentes, null, 2));
                            estadoAdmin = null;

                            if (imagemAntiga && fs.existsSync(imagemAntiga) && imagemAntiga !== novaImagemGerada) fs.unlinkSync(imagemAntiga);

                            const bufferImg = fs.readFileSync(novaImagemGerada);
                            await sock.sendMessage(remetenteReal, { image: bufferImg, caption: `✅ *Nome corrigido e arte atualizada com sucesso!*\n\n*👇 Novo Texto:*\n${militarAtual.texto}\n\n*Responda com "APROVAR" para disparar.*` });
                        } catch (err) {
                            await sock.sendMessage(remetenteReal, { text: '❌ Erro ao regerar a imagem com o novo nome.' });
                            estadoAdmin = null;
                        }
                        return;
                    }
                }

                if (comandoUpperCase === 'APROVAR') {
                    if (fs.existsSync(ARQUIVO_FILA_ANIVERSARIOS)) {
                        const pendentes = JSON.parse(fs.readFileSync(ARQUIVO_FILA_ANIVERSARIOS, 'utf8'));
                        try {
                            let enviados = 0;
                            for (let contexto of pendentes) {
                                const bufferAprovado = fs.readFileSync(contexto.imagem);
                                await sock.sendMessage(ID_DO_GRUPO, { image: bufferAprovado, caption: contexto.texto });
                                enviados++;
                                if (fs.existsSync(contexto.imagem)) fs.unlinkSync(contexto.imagem);
                                await new Promise(resolve => setTimeout(resolve, 2000));
                            }
                            await sock.sendMessage(remetenteReal, { text: `✅ ${enviados} cartão(ões) disparado(s) com sucesso!` });
                            fs.unlinkSync(ARQUIVO_FILA_ANIVERSARIOS); 
                        } catch (err) {
                            await sock.sendMessage(remetenteReal, { text: '❌ Erro ao processar o envio.' });
                        }
                    } else await sock.sendMessage(remetenteReal, { text: '⚠ Nenhum cartão aguardando aprovação.' });
                    return;
                }

                if (comandoUpperCase === 'EDITAR' || comandoUpperCase === 'CORRIGIR') {
                    if (!fs.existsSync(ARQUIVO_FILA_ANIVERSARIOS)) {
                        await sock.sendMessage(remetenteReal, { text: '⚠ Nenhum aniversariante pendente.' });
                        return;
                    }
                    const pendentes = JSON.parse(fs.readFileSync(ARQUIVO_FILA_ANIVERSARIOS, 'utf8'));

                    if (pendentes.length === 1) {
                        estadoAdmin = { acao: 'esperando_novo_nome', index: 0 };
                        await sock.sendMessage(remetenteReal, { text: `✏ Editando o único aniversariante da lista: *${pendentes[0].posto} ${pendentes[0].nomeGuerra}*\n\nDigite o Posto e o Nome separados por um TRAÇO (-).\n**Coloque entre asteriscos a parte que ficará em NEGRITO na imagem.**\n\nExemplo: *3º Sgt - João *Silva**` });
                    } else {
                        estadoAdmin = { acao: 'selecionando_militar' };
                        let lista = '👥 *Qual aniversariante deseja editar?*\n\n';
                        pendentes.forEach((m, idx) => { lista += `${idx + 1}️⃣ ${m.posto} ${m.nomeGuerra}\n`; });
                        lista += '\nDigite o *número* correspondente ou envie *CANCELAR*:';
                        await sock.sendMessage(remetenteReal, { text: lista });
                    }
                    return;
                }

                if (comandoUpperCase === 'VERIFICAR') {
                    await sock.sendMessage(remetenteReal, { text: '🔍 *DEBUG:* Iniciando varredura na planilha...' });
                    await verificarAniversarios(sock, remetenteReal);
                    return;
                }

                if (comandoUpperCase === 'LISTAMES') {
                    await sock.sendMessage(remetenteReal, { text: '📊 *DEBUG:* Gerando a lista do mês...' });
                    await enviarListaAniversariantesMes(sock);
                    return;
                }

                if (comandoUpperCase === '/MENU' || comandoUpperCase === '/ADMIN') {
                    let estado = getEstadoAtendimento();
                    let statusTxt = estado.disponivel ? '🟢 ONLINE' : '🔴 OFFLINE';

                    const textoMenuAdmin = `👑 *PAINEL DE CONTROLE DO ADMINISTRADOR* 👑

🎂 *Gestão de Aniversários:*
1️⃣ *APROVAR* - Dispara as artes pendentes no grupo.
2️⃣ *EDITAR* - Corrige o nome/posto de um aniversariante.
3️⃣ *VERIFICAR* - Força a busca de aniversariantes do dia.
4️⃣ *LISTAMES* - Gera o relatório de aniversariantes do mês atual.

📦 *Gestão de Pedidos e Dados:*
👉 */PEDIDO* - Atualiza o status de um pedido do sistema.
👉 */CRUZAR* - Atualiza a base do banco oficial.

🎧 *Atendimento Humano (Status: ${statusTxt}):*
👉 */DISPONIVEL* - Fica online para transferências diretas.
👉 */INDISPONIVEL* - Fica offline e joga na fila de espera.
👉 */FILA* - Mostra a lista de civis aguardando.
👉 */ATENDER* - Puxa o primeiro civil da fila.
👉 */FINALIZAR* - Encerra o atendimento *(dentro do chat do civil)*.

🛠️ *Geral:*
👉 */MENU* - Exibe esta lista de comandos.`;

                    await sock.sendMessage(remetenteReal, { text: textoMenuAdmin });
                    return;
                }

                if (msg.key.fromMe) return; 
            }

            // ==========================================
            // 🌐 FLUXO 3: PÚBLICO E TESTE DA URA (ADMIN)
            // ==========================================
            if (msg.key.fromMe && textoMsg.length > 80) return;

            let estado = getEstadoAtendimento();

            if (estado.ativos[remetenteReal]) {
                console.log(`🔇 [URA] Ignorando ${remetenteReal}, usuário está em atendimento humano.`);
                return; 
            }

            if (estado.fila.includes(remetenteReal)) {
                console.log(`⏳ [URA] Usuário ${remetenteReal} interagiu mas está na fila. Enviando aviso de espera.`);
                const posicao = estado.fila.indexOf(remetenteReal) + 1;
                await sock.sendMessage(remetenteReal, { text: `⏳ Você já está na nossa fila de espera na posição: *${posicao}º*.\n\nPor favor, aguarde mais um pouco, logo um militar irá te atender!` });
                return;
            }

            // 🌟 O GRANDE TRUQUE DO AUTOATENDIMENTO COM RETENÇÃO NA QUARENTENA 🌟
            if (estado.usuarios_ura[remetenteReal] && estado.usuarios_ura[remetenteReal].passo === 'aguardando_idt') {
                console.log(`🤖 [URA] Usuário ${remetenteReal} está no passo de informar IDT.`);
                const idtDigitada = textoMsg.trim().replace(/[^a-zA-Z0-9]/g, ''); 
                console.log(`🤖 [URA] IDT Extraída/Limpa: ${idtDigitada}`);

                const militarDB = await pesquisarMilitarPorIdentidade(idtDigitada);
                
                if (militarDB) {
                    console.log(`✅ [URA] Militar encontrado para IDT ${idtDigitada}: ${militarDB.nome_guerra}`);
                    
                    // Vincula o número
                    console.log(`🔗 [BD] Vinculando telefone ${remetenteReal} à IDT ${idtDigitada}`);
                    await dbExec(`UPDATE militares SET telefone = ? WHERE identidade_militar = ?`, [remetenteReal, idtDigitada]);
                    
                    // Varre a Tabela de Quarentena em busca de pedidos perdidos
                    console.log(`🔍 [BD] Buscando pedidos na quarentena para o telefone ${remetenteReal}...`);
                    const pedidosPendentes = await dbAll(`SELECT * FROM pedidos_aguardando_vinculo WHERE telefone = ?`, [remetenteReal]);

                    if (pedidosPendentes && pedidosPendentes.length > 0) {
                        console.log(`📦 [BD] Foram encontrados ${pedidosPendentes.length} pedidos na quarentena! Movendo para o oficial...`);
                        for (let ped of pedidosPendentes) {
                            await dbExec(
                                `INSERT INTO pedidos (identidade_militar, tipo_pedido, data_pedido, descricao, quantidade, valor_unitario, valor_total, status) 
                                VALUES (?, ?, ?, 'Pedido via Forms Webhook (Vinculado pelo usuário)', ?, ?, ?, 'AGUARDANDO PAGAMENTO')`,
                                [idtDigitada, ped.tipo_pedido, ped.data_pedido, ped.quantidade, ped.valor_unitario, ped.valor_total]
                            );
                            
                            const pedidoSalvo = await dbGet(`SELECT seq AS id FROM sqlite_sequence WHERE name='pedidos'`);
                            const idPedido = pedidoSalvo.id;

                            await dbExec(`INSERT INTO pagamentos (id_pedido, valor, forma_pagamento, status_pagamento) VALUES (?, ?, 'PIX', 'PENDENTE')`, [idPedido, ped.valor_total]);
                            if (ped.comprovante) {
                                await dbExec(`INSERT INTO anexos (id_pedido, tipo_anexo, nome_arquivo, url) VALUES (?, 'Comprovante PIX', 'comprovante_transferencia', ?)`, [idPedido, ped.comprovante]);
                            }

                            console.log(`🧹 [BD] Limpando pedido ${ped.id} da quarentena.`);
                            await dbExec(`DELETE FROM pedidos_aguardando_vinculo WHERE id = ?`, [ped.id]);
                        }
                        
                        await sock.sendMessage(remetenteReal, { text: `✅ *Vínculo realizado com sucesso!*\n\nIdentificamos que você possuía ${pedidosPendentes.length} pedido(s) aguardando em sistema. Eles foram processados e vinculados oficialmente à sua Identidade Militar.` });
                        await new Promise(resolve => setTimeout(resolve, 1500));
                    }

                    delete estado.usuarios_ura[remetenteReal]; 
                    salvarEstadoAtendimento(estado);

                    console.log(`📊 [URA] Gerando extrato final de pedidos para o usuário...`);
                    const pedidos = await listarHistoricoMilitar(idtDigitada);

                    if (pedidos.length > 0) {
                        let msgPedidos = `📦 *HISTÓRICO DE PEDIDOS*\n👤 Militar: *${militarDB.posto_graduacao} ${militarDB.nome_guerra}*\n\n`;
                        pedidos.forEach(p => {
                            let dataFormatada = moment(p.data_pedido).format('DD/MM/YYYY');
                            let valorTotal = parseFloat(p.valor_total).toFixed(2).replace('.', ',');
                            msgPedidos += `PRODUTO: *${p.tipo_pedido}*\n`;
                            msgPedidos += `DATA PEDIDO: ${dataFormatada}\n`;
                            msgPedidos += `QUANTIDADE: ${p.quantidade}\n`;
                            msgPedidos += `STATUS: *${p.status}*\n`;
                            msgPedidos += `VALOR Total: R$ ${valorTotal}\n`;
                            if (p.observacao) msgPedidos += `OBS: ${p.observacao}\n`;
                            msgPedidos += `\n`;
                        });
                        await sock.sendMessage(remetenteReal, { text: msgPedidos });
                    } else {
                        await sock.sendMessage(remetenteReal, { text: `✅ Identidade validada com sucesso, *${militarDB.posto_graduacao} ${militarDB.nome_guerra}*.\n\nContudo, não encontramos nenhum pedido registrado no seu nome até o momento.` });
                    }

                } else {
                    console.log(`❌ [URA] IDT ${idtDigitada} não existe no banco.`);
                    delete estado.usuarios_ura[remetenteReal]; 
                    salvarEstadoAtendimento(estado);
                    await sock.sendMessage(remetenteReal, { text: `❌ Número de Identidade Militar *não encontrado* no sistema.\n\nVerifique se você digitou corretamente. Se precisar de ajuda ou quiser abrir um pedido, digite *6* no menu principal para falar com a equipe.` });
                }
                return;
            }

            console.log(`🤖 [URA] Processando comando padrão do menu: ${comandoUpperCase}`);
            switch (comandoUpperCase) {
                case '1':
                    await sock.sendMessage(remetenteReal, { text: '📍 *Localização e Contatos*\n\n*Endereço:* Quartel da Companhia de Comando, Rod. Transamazônica, Km 06 - Marabá, PA\n*Contato da Com Soc:* (94) 93300-4881 (Sgt Vaz)\n*Expediente:* Seg a Qui (08:00 às 17:00), Sex (08:00 às 12:00)' });
                    break;
                case '2':
                    await sock.sendMessage(remetenteReal, { text: '🪖 *Alistamento e Ingresso*\n\nPara dúvidas sobre o Alistamento Militar, regularização de reservista ou ingresso na força, procure a *Junta de Serviço Militar* do seu município ou acesse o site oficial:\n🔗 https://alistamento.eb.mil.br' });
                    break;
                case '3':
                    await sock.sendMessage(remetenteReal, { text: '📰 *Imprensa e Parcerias*\n\nDemandas de imprensa ou propostas de parceria institucional devem ser tratadas diretamente com nossa equipe. \n\n👉 Digite *6* para falar com o Chefe da Seção de Comunicação Social.' });
                    break;
                case '4':
                    await sock.sendMessage(remetenteReal, { text: '🎖️ *Eventos e Solenidades*\n\nAcompanhe nossas redes sociais oficiais para ficar por dentro das próximas formaturas, desfiles e eventos institucionais abertos à comunidade!' });
                    break;
                case '5':
                    console.log(`🔍 [URA] Opção 5 acionada por ${remetenteReal}. Verificando se já possui vínculo...`);
                    const militarEncontrado = await pesquisarMilitarPorTelefone(remetenteReal);
                    
                    if (militarEncontrado) {
                        console.log(`✅ [URA] Vínculo existente encontrado: ${militarEncontrado.nome_guerra}`);
                        const pedidos = await listarHistoricoMilitar(militarEncontrado.identidade_militar);
                        
                        if (pedidos.length > 0) {
                            let msgPedidos = `📦 *HISTÓRICO DE PEDIDOS*\n👤 Militar: *${militarEncontrado.posto_graduacao} ${militarEncontrado.nome_guerra}*\n\n`;
                            pedidos.forEach(p => {
                                let dataFormatada = moment(p.data_pedido).format('DD/MM/YYYY');
                                let valorTotal = parseFloat(p.valor_total).toFixed(2).replace('.', ',');
                                msgPedidos += `PRODUTO: *${p.tipo_pedido}*\n`;
                                msgPedidos += `DATA PEDIDO: ${dataFormatada}\n`;
                                msgPedidos += `QUANTIDADE: ${p.quantidade}\n`;
                                msgPedidos += `STATUS: *${p.status}*\n`;
                                msgPedidos += `VALOR Total: R$ ${valorTotal}\n`;
                                if (p.observacao) msgPedidos += `OBS: ${p.observacao}\n`;
                                msgPedidos += `\n`;
                            });
                            await sock.sendMessage(remetenteReal, { text: msgPedidos });
                        } else {
                            await sock.sendMessage(remetenteReal, { text: `Olá, *${militarEncontrado.posto_graduacao} ${militarEncontrado.nome_guerra}*. \n\nVocê está cadastrado no sistema, mas não encontramos nenhum pedido registrado no seu nome até o momento.` });
                        }
                    } else {
                        console.log(`⚠️ [URA] Sem vínculo prévio. Colocando usuário no estado 'aguardando_idt'.`);
                        estado.usuarios_ura[remetenteReal] = { passo: 'aguardando_idt' };
                        salvarEstadoAtendimento(estado);
                        
                        await sock.sendMessage(remetenteReal, { text: `🔍 *Consulta de Pedidos*\n\nNão localizei nenhum cadastro prévio associado a este número de WhatsApp.\n\n👉 Por favor, digite o seu *Número de Identidade Militar* (com todos os dígitos) para que eu possa localizar seus pedidos e vincular o seu número:` });
                    }
                    break;
                case '6':
                    console.log(`🗣️ [URA] Opção 6 (Atendimento Humano) solicitada por ${remetenteReal}`);
                    if (estado.disponivel) {
                        estado.ativos[remetenteReal] = true;
                        salvarEstadoAtendimento(estado);
                        await sock.sendMessage(remetenteReal, { text: '🟢 Transferindo o seu atendimento...\n\nDentro de alguns minutos, um de nossos militares da Seção de Comunicação Social irá responder por aqui. Aguarde um instante! 🤝' });
                        await sock.sendMessage(SEU_NUMERO, { text: `🔔 *NOVO ATENDIMENTO:* O número wa.me/${remetenteReal.split('@')[0]} acabou de pedir atendimento humano e você está DISPONÍVEL.` });
                    } else {
                        estado.fila.push(remetenteReal);
                        salvarEstadoAtendimento(estado);
                        const posicao = estado.fila.length;
                        await sock.sendMessage(remetenteReal, { text: `🔴 *Atendimento Indisponível no Momento*\n\nNossa equipe não está atendendo neste exato momento, mas você foi adicionado(a) à nossa fila de espera.\n\n*Sua posição na fila:* ${posicao}º\n\nAssim que o expediente normalizar ou um militar estiver disponível, ele chamará você por aqui!` });
                        await sock.sendMessage(SEU_NUMERO, { text: `🔔 *Lembrete:* Alguém (wa.me/${remetenteReal.split('@')[0]}) tentou falar com a seção, mas você está INDISPONÍVEL. Ele foi para a fila. (Total: ${posicao} pessoa(s))` });
                    }
                    break;
                default:
                    const menuTexto = `👋 Olá! Seja bem-vindo ao canal de atendimento da *Comunicação Social da Companhia de Comando da 23ª Brigada de Infantaria de Selva*. 🇧🇷\n\nPara agilizar seu atendimento, responda com o *número* da opção desejada:\n\n*1️⃣ - Localização e Contatos*\n*2️⃣ - Dúvidas sobre Alistamento e Ingresso*\n*3️⃣ - Imprensa e Parcerias*\n*4️⃣ - Eventos e Solenidades*\n*5️⃣ - Consultar Meus Pedidos*\n*6️⃣ - Falar com a Equipe (Atendimento Humano)*`;
                    await sock.sendMessage(remetenteReal, { text: menuTexto });
                    break;
            }
        }
    });
}

function iniciarAgendamento(sock) {
    cron.schedule('0 7 * * *', () => { verificarAniversarios(sock); });
    cron.schedule('0 8 1 * *', () => { enviarListaAniversariantesMes(sock); });
}

async function enviarListaAniversariantesMes(sock) {
    try {
        const workbook = xlsx.readFile(ARQUIVO_PLANILHA, { cellDates: true });
        const militares = xlsx.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]]);
        const mesAtual = moment().format('MM');
        const nomeMes = moment().format('MMMM').toUpperCase();
        let lista = [];

        for (let militar of militares) {
            const dados = extrairDadosMilitar(militar);
            if (!dados.dataNascRaw || !dados.posto || !dados.nomeGuerra) continue;
            let dataNasc;
            if (dados.dataNascRaw instanceof Date) dataNasc = moment.utc(dados.dataNascRaw);
            else if (typeof dados.dataNascRaw === 'string') dataNasc = moment(dados.dataNascRaw, ['DD/MM/YYYY', 'D/M/YYYY', 'DD-MM-YYYY', 'YYYY-MM-DD']);
            else if (typeof dados.dataNascRaw === 'number') dataNasc = moment(new Date((dados.dataNascRaw - 25569) * 86400 * 1000));
            else continue;
            if (!dataNasc || !dataNasc.isValid()) continue;
            if (dataNasc.format('MM') === mesAtual) lista.push({ diaInt: parseInt(dataNasc.format('DD')), texto: `*${dataNasc.format('DD/MM')}* - ${dados.posto} ${dados.nomeGuerra}` });
        }

        const [result] = await sock.onWhatsApp(SEU_NUMERO);
        if (result && result.exists) {
            if (lista.length > 0) {
                lista.sort((a, b) => a.diaInt - b.diaInt);
                let mensagem = `🗓️ *ANIVERSARIANTES DO MÊS DE ${nomeMes}*\n\n` + lista.map(m => `🎂 ${m.texto}\n`).join('');
                await sock.sendMessage(result.jid, { text: mensagem });
            } else await sock.sendMessage(result.jid, { text: `ℹ️ Não há aniversariantes para o mês de ${nomeMes}.` });
        }
    } catch (erro) { console.error('Erro na lista mensal:', erro); }
}

async function gerarImagem(posto, nomeCompleto, nomeGuerra) {
    const background = await loadImage(TEMPLATE_IMAGEM);
    const canvas = createCanvas(background.width, background.height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(background, 0, 0, canvas.width, canvas.height);

    const xCentroNome = 1238; const yTextNome = 537; const maxTextWidth = 2000; 
    const partesNome = nomeCompleto.split(new RegExp(`(${nomeGuerra})`, 'i'));

    ctx.textBaseline = 'middle'; ctx.textAlign = 'left'; 
    let fontSize = 120; let totalWidth = 0; let normalFont; let boldFont;

    do {
        totalWidth = 0;
        normalFont = `italic ${fontSize}px "Times New Roman"`; boldFont = `bold italic ${fontSize}px "Times New Roman"`;
        ctx.font = normalFont; totalWidth += ctx.measureText(`${posto} `).width;
        partesNome.forEach(parte => {
            ctx.font = (parte.toUpperCase() === nomeGuerra.toUpperCase()) ? boldFont : normalFont;
            totalWidth += ctx.measureText(parte).width;
        });
        if (totalWidth > maxTextWidth) fontSize -= 2;
    } while (totalWidth > maxTextWidth && fontSize > 30); 

    let xAtual = xCentroNome - (totalWidth / 2); ctx.fillStyle = '#000000'; 
    ctx.font = normalFont; ctx.fillText(`${posto} `, xAtual, yTextNome); xAtual += ctx.measureText(`${posto} `).width;
    partesNome.forEach(parte => {
        ctx.font = (parte.toUpperCase() === nomeGuerra.toUpperCase()) ? boldFont : normalFont;
        ctx.fillText(parte, xAtual, yTextNome); xAtual += ctx.measureText(parte).width;
    });

    const dataAtual = moment().format('D [de] MMMM [de] YYYY');
    ctx.font = `75px "Times New Roman"`; ctx.textAlign = 'center'; ctx.fillText(`Marabá-PA, ${dataAtual}`, 1258, 1259);

    const outputPath = `./aniversario_gerado_${nomeGuerra.replace(/\s/g, '_')}.png`;
    fs.writeFileSync(outputPath, canvas.toBuffer('image/png'));
    return outputPath;
}

async function verificarAniversarios(sock, remetenteAdmin = null) {
    limparImagensResiduais();
    const workbook = xlsx.readFile(ARQUIVO_PLANILHA, { cellDates: true });
    const militares = xlsx.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]]);
    const hoje = moment(); const diaMesHoje = hoje.format('DD/MM'); const anoAtual = hoje.year();
    let fila = [];

    for (let militar of militares) {
        const dados = extrairDadosMilitar(militar);
        if (!dados.dataNascRaw || !dados.posto || !dados.nomeGuerra || !dados.nomeCompleto) continue;
        let dataNasc;
        if (dados.dataNascRaw instanceof Date) dataNasc = moment.utc(dados.dataNascRaw);
        else if (typeof dados.dataNascRaw === 'string') dataNasc = moment(dados.dataNascRaw, ['DD/MM/YYYY', 'D/M/YYYY', 'DD-MM-YYYY', 'YYYY-MM-DD']);
        else if (typeof dados.dataNascRaw === 'number') dataNasc = moment(new Date((dados.dataNascRaw - 25569) * 86400 * 1000));
        else continue;

        if (!dataNasc || !dataNasc.isValid()) continue;
        if (dataNasc.year() < 1900) dataNasc.add(100, 'years');

        if (dataNasc.format('DD/MM') === diaMesHoje) {
            const idade = anoAtual - dataNasc.year();
            const txt = `_🎉 PARABÉNS, *${dados.posto.toUpperCase()} ${dados.nomeGuerra.toUpperCase()}*! 🎉_\n\n_A Companhia de Comando da 23ª Bda Inf Sl parabeniza o ${dados.posto} ${dados.nomeGuerra} pelo seu aniversário, desejando muita saúde, felicidade, sucesso e realizações._\n \n_*Que este novo ciclo seja repleto de conquistas e bons momentos junto aos seus familiares e amigos.*_\n\nFeliz aniversário! Tudo pela Amazônia. Selva!🇧🇷`;
            try {
                const img = await gerarImagem(dados.posto, dados.nomeCompleto, dados.nomeGuerra);
                fila.push({ texto: txt, imagem: img, nomeGuerra: dados.nomeGuerra, posto: dados.posto, nomeCompleto: dados.nomeCompleto, idade });
            } catch (err) { console.error(err); }
        }
    }
    
    if (fila.length > 0) {
        const [result] = await sock.onWhatsApp(SEU_NUMERO);
        if (result && result.exists) {
            fs.writeFileSync(ARQUIVO_FILA_ANIVERSARIOS, JSON.stringify(fila));
            for (let m of fila) {
                await sock.sendMessage(result.jid, { image: fs.readFileSync(m.imagem), caption: `*[NOVO ANIVERSARIANTE]* - Hoje é o aniversário do ${m.nomeGuerra} (${m.idade} anos).\n\n*👇 Texto:* \n${m.texto}\n\n*Se o nome estiver errado, digite EDITAR.*\n*Responda com "APROVAR" para disparar.*` });
                await new Promise(res => setTimeout(res, 1000));
            }
            if (fila.length > 1) await sock.sendMessage(result.jid, { text: `ℹ Existem ${fila.length} aniversariantes hoje. Se precisar corrigir algum nome, digite *EDITAR*. Ao digitar *APROVAR*, todos serão disparados juntos.` });
        }
    } else if (remetenteAdmin) await sock.sendMessage(remetenteAdmin, { text: '⚠ *DEBUG:* Nenhum aniversariante encontrado para hoje.' });
}

iniciarBot();