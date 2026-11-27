CREATE TABLE IF NOT EXISTS cliente (
    id_cliente SERIAL PRIMARY KEY,
    nome VARCHAR(100) NOT NULL,
    email VARCHAR(100) NOT NULL UNIQUE,
    senha VARCHAR(100) NOT NULL,
    telefone VARCHAR(20),
    data_cadastro DATE DEFAULT CURRENT_DATE
);

CREATE TABLE IF NOT EXISTS categoria (
    id_categoria SERIAL PRIMARY KEY,
    nome VARCHAR(50) NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS produto (
    id_produto SERIAL PRIMARY KEY,
    id_categoria INT REFERENCES categoria(id_categoria),
    nome VARCHAR(100) NOT NULL,
    descricao TEXT,
    preco DECIMAL(10,2) NOT NULL CHECK (preco >= 0),
    estoque INT NOT NULL DEFAULT 0 CHECK (estoque >= 0),
    condicao VARCHAR(20) DEFAULT 'Novo'
);

CREATE TABLE IF NOT EXISTS pedido (
    id_pedido SERIAL PRIMARY KEY,
    id_cliente INT NOT NULL REFERENCES cliente(id_cliente),
    data_pedido DATE DEFAULT CURRENT_DATE,
    valor_total DECIMAL(10,2) NOT NULL,
    status VARCHAR(30) DEFAULT 'Pendente'
);

CREATE TABLE IF NOT EXISTS item_pedido (
    id_item SERIAL PRIMARY KEY,
    id_pedido INT NOT NULL REFERENCES pedido(id_pedido),
    id_produto INT NOT NULL REFERENCES produto(id_produto),
    quantidade INT NOT NULL CHECK (quantidade > 0),
    preco_unitario DECIMAL(10,2) NOT NULL
);

INSERT INTO categoria (nome)
SELECT nomes.nome
FROM (VALUES ('Computadores'), ('Peças'), ('Notebooks')) AS nomes(nome)
WHERE NOT EXISTS (
    SELECT 1 FROM categoria existente WHERE existente.nome = nomes.nome
);

INSERT INTO produto (id_categoria, nome, descricao, preco, estoque, condicao)
SELECT categoria.id_categoria, dados.nome, dados.descricao, dados.preco, dados.estoque, 'Novo'
FROM (VALUES
    ('Computadores', 'Computador Gamer', 'PC para jogos e estudos', 3499.90::DECIMAL(10,2), 10),
    ('Peças', 'Placa de Vídeo RTX 3050', 'Placa de vídeo para computadores', 1299.90::DECIMAL(10,2), 15),
    ('Notebooks', 'Notebook', 'Notebook para estudos e trabalho', 2799.90::DECIMAL(10,2), 8)
) AS dados(categoria, nome, descricao, preco, estoque)
JOIN categoria ON categoria.nome = dados.categoria
WHERE NOT EXISTS (
    SELECT 1 FROM produto existente WHERE existente.nome = dados.nome
);
