// O "Guarda-Costas" do Modo de Manutenção
async function verificarModoManutencao() {
    try {
        // 1. Lê as configurações globais
        const settingsDoc = await getDoc(doc(db, "settings", "global"));
        if (!settingsDoc.exists()) return;
        
        const isMaintenance = settingsDoc.data().isMaintenanceMode;
        
        if (isMaintenance) {
            // Se estiver em manutenção, verifica quem é o utilizador
            const user = auth.currentUser;
            let podeEntrar = false;
            
            if (user) {
                const userDoc = await getDoc(doc(db, "users", user.uid));
                // O Super Admin é a única exceção (God Mode)
                if (userDoc.exists() && userDoc.data().role === 'superadmin') {
                    podeEntrar = true;
                    console.log("God Mode ativado. Acesso permitido ao Super Admin.");
                }
            }

            // Se não for Super Admin (ou se for um visitante anónimo)
            if (!podeEntrar) {
                // Redireciona para a página de aviso de manutenção
                window.location.href = '/manutencao.html';
            }
        }
    } catch (error) {
        console.error("Falha ao verificar regras de manutenção:", error);
    }
}

// Executar a verificação assim que a página carrega
verificarModoManutencao();
