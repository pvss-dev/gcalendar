/**
 * build.js — identidade da build, embutida no CÓDIGO.
 *
 * Precisa ser um módulo importado, e não um arquivo lido em tempo de execução:
 * o GNOME cacheia os módulos ESM, então desabilitar e reabilitar a extensão
 * mantém o código antigo em memória. Um carimbo lido do disco no enable()
 * reportaria a versão *instalada* mesmo com o Shell rodando a *anterior* — foi
 * exatamente assim que o `--status` passou a mentir.
 *
 * Como esta constante viaja junto com o módulo, ela reflete o que está de fato
 * carregado. O install.sh reescreve este arquivo na cópia instalada.
 */
export const BUILD = 'dev';
