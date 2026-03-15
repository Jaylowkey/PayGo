import axios from 'axios';

export default async function handler(req, res) {
    // Permitir apenas requisições POST
    if (req.method !== 'POST') {
        return res.status(405).json({ success: false, error: 'Método não permitido.' });
    }

    try {
        const { orderId, clientName, phone, pdfData } = req.body;

        if (!orderId || !clientName || !phone || !pdfData) {
            return res.status(400).json({ success: false, error: 'Dados incompletos.' });
        }

        // Variáveis de Ambiente configuradas no painel da Vercel
        const EVOLUTION_API_URL = process.env.EVOLUTION_API_URL;
        const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY; 
        const INSTANCE_NAME = process.env.INSTANCE_NAME;

        let cleanPhone = phone.replace(/\D/g, '');
        if (cleanPhone.length <= 9) cleanPhone = '258' + cleanPhone;

        const base64Pure = pdfData.split('base64,')[1];
        const messageText = `Olá *${clientName}*! 👋\n\nA tua compra foi processada com sucesso pela *PayGo*.\n\n📄 Abaixo segue o teu comprovativo oficial (Pedido: ${orderId}).\n\nPodes validar a autenticidade deste documento a qualquer momento fazendo scan do QR Code no canto superior da fatura.\n\nObrigado por confiares em nós! 🇲🇿`;

        const response = await axios.post(
            `${EVOLUTION_API_URL}/message/sendMedia/${INSTANCE_NAME}`,
            {
                number: cleanPhone,
                options: { delay: 1200, presence: 'composing' },
                mediaMessage: {
                    mediatype: 'document',
                    fileName: `Fatura_${orderId}.pdf`,
                    caption: messageText,
                    media: base64Pure
                }
            },
            {
                headers: {
                    'Content-Type': 'application/json',
                    'apikey': EVOLUTION_API_KEY
                }
            }
        );

        if (response.status === 201 || response.status === 200) {
            return res.status(200).json({ success: true, message: 'Fatura enviada no WhatsApp!' });
        } else {
            throw new Error('Falha de comunicação com a API do WhatsApp.');
        }

    } catch (error) {
        console.error('Erro no envio do WhatsApp:', error?.response?.data || error.message);
        return res.status(500).json({ success: false, error: 'Erro interno ao processar o envio.' });
    }
}
