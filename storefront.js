"use strict";

function normalizarNomeProduto(nome) {
    return String(nome || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
}

async function atualizarProdutosDoBanco() {
    const botoesComprar = [...document.querySelectorAll(".comprar[data-produto]")];
    botoesComprar.forEach((botao) => { botao.disabled = true; });

    try {
        const resposta = await fetch("/api/products");
        if (!resposta.ok) throw new Error("API de produtos indisponível.");
        const produtos = await resposta.json();
        if (!Array.isArray(produtos)) throw new Error("A API retornou um catálogo inválido.");
        const porNome = new Map(produtos.map((produto) => [normalizarNomeProduto(produto.nome), produto]));
        const atualizacoes = botoesComprar.map((botao) => {
            const produto = porNome.get(normalizarNomeProduto(botao.dataset.produto));
            if (!produto) throw new Error(`Produto não encontrado no banco: ${botao.dataset.produto}.`);
            return { botao, produto };
        });

        atualizacoes.forEach(({ botao, produto }) => {
            botao.dataset.productId = produto.id_produto;
            botao.dataset.preco = produto.preco;
            botao.dataset.estoque = produto.estoque;
            const quantidade = document.querySelector(".quantidade-produto");
            if (quantidade && normalizarNomeProduto(document.querySelector("#titulo-produto")?.textContent) === normalizarNomeProduto(produto.nome)) {
                quantidade.max = String(Math.max(1, Math.min(99, Number(produto.estoque))));
                quantidade.value = String(Math.min(Number(quantidade.value) || 1, Number(quantidade.max) || 1));
            }
            if (Number(produto.estoque) < 1) {
                botao.textContent = "Sem estoque";
                return;
            }
            botao.disabled = false;

            const card = botao.closest(".card");
            if (card) {
                const descricao = card.querySelector("p");
                const preco = card.querySelector("strong");
                if (descricao && produto.descricao) descricao.textContent = produto.descricao;
                if (preco) preco.textContent = Number(produto.preco).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
            }

            const precoDetalhe = document.querySelector(".produto-detalhe > p > strong");
            if (precoDetalhe && normalizarNomeProduto(document.querySelector("#titulo-produto")?.textContent) === normalizarNomeProduto(produto.nome)) {
                precoDetalhe.textContent = Number(produto.preco).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
            }
        });
    } catch (erro) {
        console.error("Não foi possível carregar os produtos da API/PostgreSQL.", erro);
        const notificacao = document.getElementById("notificacao");
        if (notificacao) {
            notificacao.textContent = "Não foi possível carregar os produtos. Inicie o site com npm start e acesse http://localhost:3000.";
            notificacao.classList.add("mostrar");
        }
    }
}

atualizarProdutosDoBanco();
