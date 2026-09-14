const { makeWASocket, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const pino = require('pino');
const cron = require('node-cron');
const xlsx = require('xlsx');
const moment = require('moment');
moment.locale('pt-br'); 
const fs = require('fs');
const { createCanvas, loadImage } = require('canvas');
const qrcode = require('qrcode-terminal');

// ================= CONFIGURAÇÕES =================
const SEU_NUMERO = '5594992004241@s.whatsapp.net'; 
const ID_DO_GRUPO = '555481312891-1437497430@g.us'; 
const ARQUIVO_PLANILHA = './banco.xlsx';
const TEMPLATE_IMAGEM = './modelo.png';
const ARQUIVO_FILA = './aniversariantes_pendentes.json';
const ARQUIVO_PROMPT = './prompt_sistema.json';
const ARQUIVO_BLOQUEADOS = './atendimento_humano_bloqueios.json';

// Chave da API da NVIDIA para o Nemotron
const NVIDIA_API_KEY = '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';
// =================================================

// Variável de controle de estado para edição interativa do Admin
let estadoAdmin = null;

// Carrega as regras e o prompt completo do JSON
let dadosPrompt = {
    first_contact: { message: "👋 Olá! Seja bem-vindo ao atendimento da Comunicação Social." },
    system_instruction: "Você é o assistente virtual de inteligência artificial da Seção de Comunicação Social."
};

if (fs.existsSync(ARQUIVO_PROMPT)) {
    try {
        dadosPrompt = JSON.parse(fs.readFileSync(ARQUIVO_PROMPT, 'utf8'));
        console.log('📄 Prompt estruturado em JSON carregado com sucesso!');
    } catch (e) {
        console.error('⚠ Erro ao ler ou converter o arquivo prompt_sistema.json:', e);
    }
}

// === FUNÇÕES DE FAXINA DE IMAGENS ===
function limparImagensResiduais() {
    console.log('🧹 Iniciando faxina no servidor (Limpando PNGs antigos)...');
    try {
        const arquivos = fs.readdirSync('./');
        let apagados = 0;
        arquivos.forEach(arquivo => {
            if (arquivo.startsWith('aniversario_gerado_') && arquivo.endsWith('.png')) {
                fs.unlinkSync(`./${arquivo}`);
                apagados++;
            }
        });
        if (apagados > 0) console.log(`✅ Faxina concluída! ${apagados} arquivo(s) residual(is) deletado(s).`);
    } catch (erro) {
        console.error('❌ Erro durante a faxina de imagens:', erro);
    }
}

// === FUNÇÕES DE CONTROLE (TRAVA DE 24 HORAS) ===
function carregarBloqueios() {
    if (fs.existsSync(ARQUIVO_BLOQUEADOS)) {
        try {
            return JSON.parse(fs.readFileSync(ARQUIVO_BLOQUEADOS, 'utf8'));
        } catch (e) {
            return {};
        }
    }
    return {};
}

function salvarBloqueios(bloqueios) {
    fs.writeFileSync(ARQUIVO_BLOQUEADOS, JSON.stringify(bloqueios, null, 2));
}

function usuarioEstaEmAtendimentoHumano(remetente) {
    const bloqueios = carregarBloqueios();
    if (bloqueios[remetente]) {
        const tempoExpiracao = moment(bloqueios[remetente]);
        if (moment().isBefore(tempoExpiracao)) {
            return true;
        } else {
            delete bloqueios[remetente];
            salvarBloqueios(bloqueios);
        }
    }
    return false;
}

function ativarBloqueioHumano(remetente) {
    const bloqueios = carregarBloqueios();
    bloqueios[remetente] = moment().add(24, 'hours').toISOString();
    salvarBloqueios(bloqueios);
}

// === INÍCIO DO SISTEMA ===
async function iniciarBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }), 
        connectTimeoutMs: 60000, 
        defaultQueryTimeoutMs: 60000,
        keepAliveIntervalMs: 10000,
        generateHighQualityLinkPreview: true
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            console.log('\n📲 Escaneie o QR Code abaixo com o WhatsApp do BOT:');
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error)?.output?.statusCode !== 401;
            console.log('⚠ Conexão fechada. Reconectando:', shouldReconnect);
            if (shouldReconnect) iniciarBot();
            else console.log('❌ Desconectado. Apague a pasta "auth_info_baileys" e reinicie.');
        } else if (connection === 'open') {
            console.log('\n✅ Assistente conectado ao WhatsApp com sucesso! Modo de produção ativo.');
            iniciarAgendamento(sock);
            limparImagensResiduais();
        }
    });

    // Escuta todas as mensagens privadas e de grupo
    sock.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const remetenteReal = msg.key.remoteJid;
        const textoMsg = (msg.message.conversation || msg.message.extendedTextMessage?.text || '').trim();
        const ehPrivado = !remetenteReal.endsWith('@g.us');

        // ==========================================
        // 🕵️ LOGGER SILENCIOSO PARA PEGAR ID DE GRUPOS (DEBUG)
        // ==========================================
        if (!ehPrivado) {
            console.log(`\n🗣️ [DEBUG GRUPO] Mensagem detectada num grupo!`);
            console.log(`👉 Copie este ID para colocar no código: ${remetenteReal}\n`);
            return; 
        }

        if (ehPrivado) {
            const ehAdmin = remetenteReal === SEU_NUMERO || remetenteReal === '41739163279551@lid';

            // ==========================================
            // 👑 FLUXO DO ADMINISTRADOR
            // ==========================================
            if (ehAdmin) {
                const comandoAdmin = textoMsg.toUpperCase();

                if (estadoAdmin) {
                    if (comandoAdmin === 'CANCELAR') {
                        estadoAdmin = null;
                        await sock.sendMessage(remetenteReal, { text: '❌ Operação de edição cancelada.' });
                        return;
                    }

                    if (estadoAdmin.acao === 'selecionando_militar') {
                        const indice = parseInt(textoMsg) - 1;
                        const pendentes = JSON.parse(fs.readFileSync(ARQUIVO_FILA, 'utf8'));
                        
                        if (isNaN(indice) || indice < 0 || indice >= pendentes.length) {
                            await sock.sendMessage(remetenteReal, { text: '❌ Número inválido. Digite o número correspondente da lista ou envie *CANCELAR*.' });
                            return;
                        }
                        
                        estadoAdmin = { acao: 'esperando_novo_nome', index: indice };
                        await sock.sendMessage(remetenteReal, { text: `✏ Você selecionou o *${pendentes[indice].posto} ${pendentes[indice].nomeGuerra}*.\n\nAgora, digite o Posto e o Nome separados por um TRAÇO (-).\n**Coloque entre asteriscos a parte que ficará em NEGRITO na imagem.**\n\nExemplo: *3º Sgt - João *Silva**` });
                        return;
                    }

                    if (estadoAdmin.acao === 'esperando_novo_nome') {
                        const pendentes = JSON.parse(fs.readFileSync(ARQUIVO_FILA, 'utf8'));
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
                            console.log(`✏ Regenerando imagem corrigida para ${novoPosto} ${novoNomeCompleto}...`);
                            const novaImagemGerada = await gerarImagem(novoPosto, novoNomeCompleto, novoNomeGuerra);
                            militarAtual.imagem = novaImagemGerada;

                            pendentes[index] = militarAtual;
                            fs.writeFileSync(ARQUIVO_FILA, JSON.stringify(pendentes, null, 2));

                            estadoAdmin = null;

                            if (imagemAntiga && fs.existsSync(imagemAntiga) && imagemAntiga !== novaImagemGerada) {
                                fs.unlinkSync(imagemAntiga);
                            }

                            const bufferImg = fs.readFileSync(novaImagemGerada);
                            await sock.sendMessage(remetenteReal, {
                                image: bufferImg,
                                caption: `✅ *Nome corrigido e arte atualizada com sucesso!*\n\n*👇 Novo Texto:*\n${militarAtual.texto}\n\n*Responda com "APROVAR" para disparar.*`
                            });
                        } catch (err) {
                            console.error('Erro ao regerar imagem:', err);
                            await sock.sendMessage(remetenteReal, { text: '❌ Erro ao regerar a imagem com o novo nome.' });
                            estadoAdmin = null;
                        }
                        return;
                    }
                }

                if (comandoAdmin === 'APROVAR') {
                    if (fs.existsSync(ARQUIVO_FILA)) {
                        const pendentes = JSON.parse(fs.readFileSync(ARQUIVO_FILA, 'utf8'));
                        try {
                            let enviados = 0;
                            for (let contexto of pendentes) {
                                const bufferAprovado = fs.readFileSync(contexto.imagem);
                                await sock.sendMessage(ID_DO_GRUPO, {
                                    image: bufferAprovado,
                                    caption: contexto.texto
                                });
                                enviados++;
                                
                                if (fs.existsSync(contexto.imagem)) {
                                    fs.unlinkSync(contexto.imagem);
                                }
                                await new Promise(resolve => setTimeout(resolve, 2000));
                            }
                            await sock.sendMessage(remetenteReal, { text: `✅ ${enviados} cartão(ões) disparado(s) e arquivos deletados do servidor com sucesso!` });
                            fs.unlinkSync(ARQUIVO_FILA); 
                        } catch (err) {
                            console.error('Erro ao aprovar:', err);
                            await sock.sendMessage(remetenteReal, { text: '❌ Erro ao processar o envio.' });
                        }
                    } else {
                        await sock.sendMessage(remetenteReal, { text: '⚠ Nenhum cartão aguardando aprovação no momento.' });
                    }
                    return;
                }

                if (comandoAdmin === 'EDITAR' || comandoAdmin === 'CORRIGIR') {
                    if (!fs.existsSync(ARQUIVO_FILA)) {
                        await sock.sendMessage(remetenteReal, { text: '⚠ Nenhum aniversariante pendente para editar no momento.' });
                        return;
                    }
                    const pendentes = JSON.parse(fs.readFileSync(ARQUIVO_FILA, 'utf8'));

                    if (pendentes.length === 1) {
                        estadoAdmin = { acao: 'esperando_novo_nome', index: 0 };
                        await sock.sendMessage(remetenteReal, { text: `✏ Editando o único aniversariante da lista: *${pendentes[0].posto} ${pendentes[0].nomeGuerra}*\n\nDigite o Posto e o Nome separados por um TRAÇO (-).\n**Coloque entre asteriscos a parte que ficará em NEGRITO na imagem.**\n\nExemplo: *3º Sgt - João *Silva**` });
                    } else {
                        estadoAdmin = { acao: 'selecionando_militar' };
                        let lista = '👥 *Há múltiplos aniversariantes hoje. Qual deles você deseja editar?*\n\n';
                        pendentes.forEach((m, idx) => {
                            lista += `${idx + 1}️⃣ ${m.posto} ${m.nomeGuerra}\n`;
                        });
                        lista += '\nDigite o *número* correspondente ou envie *CANCELAR*:';
                        await sock.sendMessage(remetenteReal, { text: lista });
                    }
                    return;
                }

                if (comandoAdmin === 'VERIFICAR') {
                    await sock.sendMessage(remetenteReal, { text: '🔍 *DEBUG:* Iniciando a varredura manual diária na planilha...' });
                    await verificarAniversarios(sock, remetenteReal);
                    return;
                }

                if (comandoAdmin === 'LISTAMES') {
                    await sock.sendMessage(remetenteReal, { text: '📊 *DEBUG:* Gerando a lista de aniversariantes deste mês...' });
                    await enviarListaAniversariantesMes(sock);
                    return;
                }

                if (comandoAdmin === 'DESBLOQUEAR') {
                    fs.writeFileSync(ARQUIVO_BLOQUEADOS, JSON.stringify({}));
                    await sock.sendMessage(remetenteReal, { text: '🔓 *DEBUG:* Todos os bloqueios de atendimento humano foram zerados. A IA voltou a responder todo mundo!' });
                    return;
                }

                if (comandoAdmin === '/ADMIN' || comandoAdmin === 'MENU') {
                    await sock.sendMessage(remetenteReal, { 
                        text: `👑 *PAINEL DE CONTROLE DO ADMINISTRADOR*\n\n1️⃣ Digite *APROVAR* para disparar os cartões no grupo da Cia.\n2️⃣ Digite *EDITAR* se o nome de algum aniversariante estiver errado.\n3️⃣ Digite *VERIFICAR* para forçar a busca de aniversariantes do dia.\n4️⃣ Digite *LISTAMES* para forçar a geração da lista do mês.\n5️⃣ Digite *DESBLOQUEAR* para zerar o limite de 24h da IA.\n\n⏰ *Agendamentos:* O bot monitora aniversários diários às 07:00 e manda o relatório mensal no dia 1º às 08:00.` 
                    });
                    return;
                }
            }

            // ==========================================
            // 🛑 VERIFICAÇÃO DA TRAVA DE 24 HORAS
            // ==========================================
            if (usuarioEstaEmAtendimentoHumano(remetenteReal)) {
                return; 
            }

            // ==========================================
            // 🌐 FLUXO DE ATENDIMENTO PÚBLICO INTELIGENTE (IA NEMOTRON)
            // ==========================================
            const upperTexto = textoMsg.toUpperCase();
            
            // 1. FILTRO DE SAUDAÇÕES (Ignora pontuações como "!!!" ou "?")
            const textoSemPontuacao = upperTexto.replace(/[^\w\sÀ-ÿ]/gi, '').trim();
            const saudacoes = ['OI', 'OLA', 'BOM DIA', 'BOA TARDE', 'BOA NOITE', 'INICIO', 'TUDO BEM'];

            if (saudacoes.includes(textoSemPontuacao) || textoSemPontuacao.length <= 2) {
                await sock.sendMessage(remetenteReal, { text: dadosPrompt.first_contact.message });
                return;
            }

            // 2. FILTRO INTELIGENTE DE TRANSFERÊNCIA IMEDIATA
            const textoNormalizado = textoMsg.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
            
            const frasesDeTransferencia = [
                'falar com atendente', 'atendimento humano', 'falar com humano', 'falar com uma pessoa', 
                'falar com pessoa', 'falar com alguem', 'passar para atendente', 'transferir para atendente', 
                'quero um atendente', 'chamar atendente', 'falar com militar', 'falar com a comunicacao',
                'preciso de atendimento'
            ];
            const palavrasExatas = ['atendente', 'humano'];

            const pediuAtendimento = frasesDeTransferencia.some(frase => textoNormalizado.includes(frase)) || palavrasExatas.includes(textoNormalizado);

            if (pediuAtendimento) {
                ativarBloqueioHumano(remetenteReal);
                const mensagemTransferencia = dadosPrompt.human_handoff?.handoff_confirmation || "Perfeito! 😊 Estou transferindo o seu atendimento...\n\nDentro de alguns minutos, um de nossos militares da Seção de Comunicação Social irá responder por aqui. Aguarde um instante! 🤝";
                await sock.sendMessage(remetenteReal, { text: mensagemTransferencia });
                return;
            }

            // 3. CONSULTA À IA (SE NÃO FOI BARRADO PELOS FILTROS ACIMA)
            const respostaIA = await consultarNemotron(textoMsg, dadosPrompt);
            await sock.sendMessage(remetenteReal, { text: respostaIA });

            // 🕵️ ESPIÃO FINAL: Só bloqueia se a IA decidir que precisa transferir
            if (respostaIA.toLowerCase().includes("transferindo o seu atendimento")) {
                ativarBloqueioHumano(remetenteReal);
                console.log(`🔒 [BLOQUEIO HUMANO] Ativado por 24h para o número: ${remetenteReal}`);
            }
        }
    });
}

// === FUNÇÃO DE INTEGRAÇÃO COM A IA (NEMOTRON 30B) VIA FETCH SEGURO ===
async function consultarNemotron(perguntaUsuario, regrasJson) {
    const invoke_url = "https://integrate.api.nvidia.com/v1/chat/completions";
    const instrucaoSistema = `${regrasJson.system_instruction}\n\nConfiguração e Contexto do Sistema em JSON:\n${JSON.stringify(regrasJson, null, 2)}`;

    const payload = {
        "model": "nvidia/nemotron-3.5-lightning-30b-a3b",
        "messages": [
            { "role": "system", "content": instrucaoSistema },
            { "role": "user", "content": perguntaUsuario }
        ],
        "temperature": 0.5, 
        "max_tokens": 1024, 
        "stream": false,
        // 🔥 ATIVAMOS O PENSAMENTO AQUI PARA ELE NÃO MISTURAR NA RESPOSTA FINAL
        "chat_template_kwargs": {
            "enable_thinking": true 
        },
        "reasoning_budget": 1024
    };

    try {
        const response = await fetch(invoke_url, {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${NVIDIA_API_KEY}`,
                "Content-Type": "application/json",
                "Accept": "application/json"
            },
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            console.error("❌ ERRO NA API DA NVIDIA");
            return "Perfeito! 😊 Estou transferindo o seu atendimento...\n\nDentro de alguns minutos, um de nossos militares da Seção de Comunicação Social irá responder por aqui. Aguarde um instante! 🤝";
        }

        const data = await response.json();
        if (data && data.choices && data.choices.length > 0) {
            // 🔥 PEGAMOS APENAS O 'content', IGNORANDO O 'reasoning_content'
            let respostaFinal = data.choices[0].message.content;
            
            if (!respostaFinal || respostaFinal.trim() === "") {
                return "Posso ajudar com mais alguma informação institucional?";
            }
            return respostaFinal.trim();
        } else {
            return "Perfeito! 😊 Estou transferindo o seu atendimento...\n\nDentro de alguns minutos, um de nossos militares da Seção de Comunicação Social irá responder por aqui. Aguarde um instante! 🤝";
        }
    } catch (error) {
        console.error("❌ ERRO DE CONEXÃO COM A IA:", error);
        return "Perfeito! 😊 Estou transferindo o seu atendimento...\n\nDentro de alguns minutos, um de nossos militares da Seção de Comunicação Social irá responder por aqui. Aguarde um instante! 🤝";
    }
}

// === AGENDAMENTO DE TAREFAS CRON ===
function iniciarAgendamento(sock) {
    cron.schedule('0 7 * * *', () => {
        console.log('⏰ [07:00] Executando varredura diária de aniversariantes...');
        verificarAniversarios(sock); 
    });

    cron.schedule('0 8 1 * *', () => {
        console.log('📅 [08:00] Gerando lista mensal de aniversariantes...');
        enviarListaAniversariantesMes(sock);
    });

    console.log('⏳ Agendamentos ativados: Diário (07:00) e Relatório Mensal (Dia 1 às 08:00).');
}

// === FUNÇÃO: LISTA DE ANIVERSARIANTES DO MÊS ===
async function enviarListaAniversariantesMes(sock) {
    try {
        const workbook = xlsx.readFile(ARQUIVO_PLANILHA, { cellDates: true });
        const sheet_name_list = workbook.SheetNames;
        const militares = xlsx.utils.sheet_to_json(workbook.Sheets[sheet_name_list[0]]);

        const mesAtual = moment().format('MM');
        const nomeMes = moment().format('MMMM').toUpperCase();
        let listaAniversariantes = [];

        for (let militar of militares) {
            let posto = '';
            let nomeGuerra = '';
            let dataNascRaw = null;

            for (let key in militar) {
                const k = key.toUpperCase().trim();
                if (k.includes('POSTO') || k.includes('GRADUA')) posto = String(militar[key]).trim();
                else if (k.includes('NOME DE GUERRA') || k.includes('GUERRA')) nomeGuerra = String(militar[key]).trim();
                else if (k.includes('NASCIMENTO') || k.includes('DATA')) dataNascRaw = militar[key];
            }

            if (!dataNascRaw || !posto || !nomeGuerra) continue;

            let dataNasc;
            if (dataNascRaw instanceof Date) dataNasc = moment.utc(dataNascRaw);
            else if (typeof dataNascRaw === 'string') dataNasc = moment(dataNascRaw, ['DD/MM/YYYY', 'D/M/YYYY', 'DD-MM-YYYY', 'YYYY-MM-DD']);
            else if (typeof dataNascRaw === 'number') dataNasc = moment(new Date((dataNascRaw - 25569) * 86400 * 1000));
            else continue;

            if (!dataNasc || !dataNasc.isValid()) continue;

            if (dataNasc.format('MM') === mesAtual) {
                listaAniversariantes.push({
                    diaInt: parseInt(dataNasc.format('DD')),
                    texto: `*${dataNasc.format('DD/MM')}* - ${posto} ${nomeGuerra}`
                });
            }
        }

        const [result] = await sock.onWhatsApp(SEU_NUMERO);
        if (result && result.exists) {
            if (listaAniversariantes.length > 0) {
                listaAniversariantes.sort((a, b) => a.diaInt - b.diaInt);
                
                let mensagem = `🗓️ *ANIVERSARIANTES DO MÊS DE ${nomeMes}*\n\n`;
                listaAniversariantes.forEach(m => {
                    mensagem += `🎂 ${m.texto}\n`;
                });

                await sock.sendMessage(result.jid, { text: mensagem });
                console.log(`✅ Relatório do mês de ${nomeMes} enviado ao admin!`);
            } else {
                await sock.sendMessage(result.jid, { text: `ℹ️ Não há aniversariantes cadastrados na planilha para o mês de ${nomeMes}.` });
            }
        }
    } catch (erro) {
        console.error('❌ Erro ao gerar lista mensal:', erro);
    }
}

// === FUNÇÃO DE GERAÇÃO DE IMAGEM ===
async function gerarImagem(posto, nomeCompleto, nomeGuerra) {
    const background = await loadImage(TEMPLATE_IMAGEM);
    const canvas = createCanvas(background.width, background.height);
    const ctx = canvas.getContext('2d');
    
    ctx.drawImage(background, 0, 0, canvas.width, canvas.height);

    const xCentroNome = 1238;
    const yTextNome = 537; 
    const maxTextWidth = 2000; 
    
    const regexGuerra = new RegExp(`(${nomeGuerra})`, 'i');
    const partesNome = nomeCompleto.split(regexGuerra);

    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left'; 
    
    let fontSize = 120; 
    let totalWidth = 0;
    
    let normalFont;
    let boldFont;

    do {
        totalWidth = 0;
        normalFont = `italic ${fontSize}px "Times New Roman"`;
        boldFont = `bold italic ${fontSize}px "Times New Roman"`;
        
        ctx.font = normalFont;
        totalWidth += ctx.measureText(`${posto} `).width;
        
        partesNome.forEach(parte => {
            if (parte.toUpperCase() === nomeGuerra.toUpperCase()) {
                ctx.font = boldFont;
            } else {
                ctx.font = normalFont;
            }
            totalWidth += ctx.measureText(parte).width;
        });

        if (totalWidth > maxTextWidth) fontSize -= 2;
    } while (totalWidth > maxTextWidth && fontSize > 30); 

    let xAtual = xCentroNome - (totalWidth / 2);
    ctx.fillStyle = '#000000'; 
    
    ctx.font = normalFont;
    ctx.fillText(`${posto} `, xAtual, yTextNome);
    xAtual += ctx.measureText(`${posto} `).width;

    partesNome.forEach(parte => {
        if (parte.toUpperCase() === nomeGuerra.toUpperCase()) {
            ctx.font = boldFont;
        } else {
            ctx.font = normalFont;
        }
        ctx.fillText(parte, xAtual, yTextNome);
        xAtual += ctx.measureText(parte).width;
    });

    const xCentroData = 1258; 
    const yTextData = 1259; 
    const dataAtual = moment().format('D [de] MMMM [de] YYYY');
    const textoData = `Marabá-PA, ${dataAtual}`;
    
    ctx.font = `75px "Times New Roman"`; 
    ctx.textAlign = 'center'; 
    ctx.fillText(textoData, xCentroData, yTextData);

    const outputPath = `./aniversario_gerado_${nomeGuerra.replace(/\s/g, '_')}.png`;
    const buffer = canvas.toBuffer('image/png');
    fs.writeFileSync(outputPath, buffer);
    
    return outputPath;
}

// === VARREDURA DE ANIVERSARIANTES DIÁRIOS ===
async function verificarAniversarios(sock, remetenteAdmin = null) {
    limparImagensResiduais();

    console.log('🔍 Lendo a planilha...');
    const workbook = xlsx.readFile(ARQUIVO_PLANILHA, { cellDates: true });
    const sheet_name_list = workbook.SheetNames;
    const militares = xlsx.utils.sheet_to_json(workbook.Sheets[sheet_name_list[0]]);

    const hoje = moment();
    const diaMesHoje = hoje.format('DD/MM');
    const anoAtual = hoje.year();

    let filaDeAprovacao = [];

    for (let militar of militares) {
        let posto = '';
        let nomeGuerra = '';
        let nomeCompleto = '';
        let dataNascRaw = null;

        for (let key in militar) {
            const k = key.toUpperCase().trim();
            if (k.includes('POSTO') || k.includes('GRADUA')) posto = String(militar[key]).trim();
            else if (k.includes('NOME DE GUERRA') || k.includes('GUERRA')) nomeGuerra = String(militar[key]).trim();
            else if (k.includes('NOME COMPLETO') || k.includes('COMPLETO')) nomeCompleto = String(militar[key]).trim();
            else if (k.includes('NASCIMENTO') || k.includes('DATA')) dataNascRaw = militar[key];
        }

        if (!dataNascRaw || !posto || !nomeGuerra || !nomeCompleto) continue;

        let dataNasc;
        if (dataNascRaw instanceof Date) dataNasc = moment.utc(dataNascRaw);
        else if (typeof dataNascRaw === 'string') dataNasc = moment(dataNascRaw, ['DD/MM/YYYY', 'D/M/YYYY', 'DD-MM-YYYY', 'YYYY-MM-DD']);
        else if (typeof dataNascRaw === 'number') dataNasc = moment(new Date((dataNascRaw - 25569) * 86400 * 1000));
        else continue;

        if (!dataNasc || !dataNasc.isValid()) continue;
        if (dataNasc.year() < 1900) dataNasc.add(100, 'years');

        if (dataNasc.format('DD/MM') === diaMesHoje) {
            const idade = anoAtual - dataNasc.year();
            console.log(`🎯 Aniversariante encontrado: ${posto} ${nomeGuerra} (${idade} anos)`);

            const textoGrupo = `_🎉 PARABÉNS, *${posto.toUpperCase()} ${nomeGuerra.toUpperCase()}*! 🎉_\n\n_A Companhia de Comando da 23ª Bda Inf Sl parabeniza o ${posto} ${nomeGuerra} pelo seu aniversário, desejando muita saúde, felicidade, sucesso e realizações._\n \n_*Que este novo ciclo seja repleto de conquistas e bons momentos junto aos seus familiares e amigos.*_\n\nFeliz aniversário! Tudo pela Amazônia. Selva!🇧🇷`;

            try {
                const imagemGerada = await gerarImagem(posto, nomeCompleto, nomeGuerra);
                filaDeAprovacao.push({ texto: textoGrupo, imagem: imagemGerada, nomeGuerra, posto, nomeCompleto, idade });
            } catch (erro) {
                console.error(`❌ Erro ao gerar imagem para ${nomeGuerra}:`, erro);
            }
        }
    }
    
    if (filaDeAprovacao.length > 0) {
        const [result] = await sock.onWhatsApp(SEU_NUMERO);
        if (result && result.exists) {
            fs.writeFileSync(ARQUIVO_FILA, JSON.stringify(filaDeAprovacao));

            for (let militar of filaDeAprovacao) {
                const bufferImagem = fs.readFileSync(militar.imagem);
                await sock.sendMessage(result.jid, {
                    image: bufferImagem, 
                    caption: `*[NOVO ANIVERSARIANTE]* - Hoje é o aniversário do ${militar.nomeGuerra} (${militar.idade} anos).\n\n*👇 Texto que será enviado no grupo:*\n${militar.texto}\n\n*Se o nome estiver errado, digite EDITAR.*\n*Responda com "APROVAR" para disparar.*`
                });
                await new Promise(resolve => setTimeout(resolve, 1000));
            }

            if (filaDeAprovacao.length > 1) {
                await sock.sendMessage(result.jid, { text: `ℹ Existem ${filaDeAprovacao.length} aniversariantes hoje.\nSe precisar corrigir algum nome, digite *EDITAR*.\nAo digitar *APROVAR*, todos serão disparados juntos.` });
            }
            console.log('✅ Avisos de aprovação enviados ao Admin!');
        }
    } else {
        console.log("Nenhum aniversariante encontrado na data de hoje.");
        if (remetenteAdmin) {
            await sock.sendMessage(remetenteAdmin, { text: '⚠ *DEBUG:* Nenhum aniversariante foi encontrado na planilha para a data de hoje.' });
        }
    }
}

iniciarBot();