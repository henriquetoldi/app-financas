from pathlib import Path

path = Path('App.jsx')
text = path.read_text(encoding='utf-8')
start = text.index('      <form id="form-compra-programada"')
end_marker = '      </form>'
end = text.index(end_marker, start) + len(end_marker)

novo = r'''      <style>{`
        .compras-form-card {
          border: 1px solid #e2e8f0;
          border-radius: 16px;
          padding: 20px;
          background: #f8fafc;
          margin-bottom: 22px;
        }
        .compras-form-header {
          display: flex;
          justify-content: space-between;
          align-items: flex-start;
          gap: 16px;
          margin-bottom: 18px;
        }
        .compras-form-header h2 {
          margin: 0;
          font-size: 20px;
          color: #0f172a;
        }
        .compras-form-header p {
          margin: 5px 0 0;
          color: #64748b;
          line-height: 1.45;
        }
        .compras-form-section {
          display: grid;
          gap: 14px;
        }
        .compras-form-grid-primary,
        .compras-form-grid-secondary {
          display: grid;
          gap: 14px;
          align-items: end;
        }
        .compras-form-grid-primary {
          grid-template-columns: minmax(280px, 2fr) minmax(160px, .85fr) minmax(175px, .95fr);
        }
        .compras-form-grid-secondary {
          grid-template-columns: repeat(3, minmax(0, 1fr));
        }
        .compras-field {
          display: flex;
          flex-direction: column;
          gap: 7px;
          min-width: 0;
          color: #334155;
          font-size: 13px;
          font-weight: 650;
          line-height: 1.25;
        }
        .compras-field-label {
          display: block;
          min-height: 16px;
          white-space: normal;
        }
        .compras-required {
          color: #dc2626;
          margin-left: 2px;
        }
        .compras-field input,
        .compras-field select,
        .compras-field textarea {
          width: 100%;
          min-width: 0;
          box-sizing: border-box;
          border: 1px solid #cbd5e1;
          border-radius: 10px;
          background: #ffffff;
          color: #0f172a;
          font: inherit;
          font-size: 14px;
          font-weight: 400;
          outline: none;
          transition: border-color .15s ease, box-shadow .15s ease, background .15s ease;
        }
        .compras-field input,
        .compras-field select {
          height: 44px;
          padding: 0 12px;
        }
        .compras-field textarea {
          min-height: 92px;
          padding: 11px 12px;
          line-height: 1.45;
          resize: vertical;
        }
        .compras-field input:focus,
        .compras-field select:focus,
        .compras-field textarea:focus {
          border-color: #3b82f6;
          box-shadow: 0 0 0 3px rgba(59, 130, 246, .12);
        }
        .compras-field select:disabled {
          background: #f1f5f9;
          color: #94a3b8;
          cursor: not-allowed;
        }
        .compras-form-observacoes {
          margin-top: 14px;
        }
        .compras-form-actions {
          display: flex;
          justify-content: flex-end;
          gap: 10px;
          margin-top: 18px;
          padding-top: 16px;
          border-top: 1px solid #e2e8f0;
        }
        @media (max-width: 1100px) {
          .compras-form-grid-primary {
            grid-template-columns: repeat(2, minmax(0, 1fr));
          }
          .compras-field-description {
            grid-column: 1 / -1;
          }
          .compras-form-grid-secondary {
            grid-template-columns: repeat(2, minmax(0, 1fr));
          }
        }
        @media (max-width: 720px) {
          .compras-form-card {
            padding: 16px;
          }
          .compras-form-header {
            flex-direction: column;
            align-items: stretch;
          }
          .compras-form-grid-primary,
          .compras-form-grid-secondary {
            grid-template-columns: 1fr;
          }
          .compras-field-description {
            grid-column: auto;
          }
          .compras-form-actions {
            flex-direction: column-reverse;
          }
          .compras-form-actions .btn {
            width: 100%;
          }
        }
      `}</style>

      <form id="form-compra-programada" onSubmit={salvarCompra} className="compras-form-card">
        <div className="compras-form-header">
          <div>
            <h2>{editandoId ? '✏️ Editar compra programada' : '🛒 Nova compra programada'}</h2>
            <p>Cadastre a intenção de compra. A análise de impacto no caixa será adicionada na próxima etapa.</p>
          </div>
          {editandoId && <Btn type="button" onClick={limparFormulario}>Cancelar edição</Btn>}
        </div>

        <div className="compras-form-section">
          <div className="compras-form-grid-primary">
            <label className="compras-field compras-field-description">
              <span className="compras-field-label">O que você quer comprar?<span className="compras-required">*</span></span>
              <input value={form.descricao} onChange={(e) => setForm({ ...form, descricao: e.target.value })} placeholder="Ex.: notebook, TV, viagem..." />
            </label>
            <label className="compras-field">
              <span className="compras-field-label">Valor estimado<span className="compras-required">*</span></span>
              <input type="number" min="0.01" step="0.01" value={form.valorEstimado} onChange={(e) => setForm({ ...form, valorEstimado: e.target.value })} placeholder="0,00" />
            </label>
            <label className="compras-field">
              <span className="compras-field-label">Data desejada<span className="compras-required">*</span></span>
              <input type="date" value={form.dataDesejada} onChange={(e) => setForm({ ...form, dataDesejada: e.target.value })} />
            </label>
          </div>

          <div className="compras-form-grid-secondary">
            <label className="compras-field">
              <span className="compras-field-label">Prioridade<span className="compras-required">*</span></span>
              <select value={form.prioridade} onChange={(e) => setForm({ ...form, prioridade: e.target.value })}><option value="BAIXA">Baixa</option><option value="MEDIA">Média</option><option value="ALTA">Alta</option><option value="ESSENCIAL">Essencial</option></select>
            </label>
            <label className="compras-field">
              <span className="compras-field-label">Forma de pagamento<span className="compras-required">*</span></span>
              <select value={form.formaPagamento} onChange={(e) => setForm({ ...form, formaPagamento: e.target.value, parcelas: e.target.value === 'A_VISTA' ? 1 : Math.max(2, Number(form.parcelas) || 2) })}><option value="A_VISTA">À vista</option><option value="PARCELADO">Parcelado</option></select>
            </label>
            {form.formaPagamento === 'PARCELADO' && <label className="compras-field">
              <span className="compras-field-label">Parcelas<span className="compras-required">*</span></span>
              <input type="number" min="2" max="60" value={form.parcelas} onChange={(e) => setForm({ ...form, parcelas: e.target.value })} />
            </label>}
          </div>

          <div className="compras-form-grid-secondary">
            <label className="compras-field">
              <span className="compras-field-label">Conta pretendida</span>
              <select value={form.contaId} onChange={(e) => setForm({ ...form, contaId: e.target.value })}><option value="">Ainda não definida</option>{contas.filter((conta) => conta.ativo !== false).map((conta) => <option key={conta.id} value={conta.id}>{conta.nome}</option>)}</select>
            </label>
            <label className="compras-field">
              <span className="compras-field-label">Categoria macro</span>
              <select value={form.categoriaMacroId} onChange={(e) => setForm({ ...form, categoriaMacroId: e.target.value, categoriaDetalhadaId: '' })}><option value="">Sem categoria</option>{categoriasAgrupadas.map((categoria) => <option key={categoria.id} value={categoria.id}>{categoria.emoji || ''} {categoria.nome}</option>)}</select>
            </label>
            <label className="compras-field">
              <span className="compras-field-label">Categoria detalhada</span>
              <select value={form.categoriaDetalhadaId} onChange={(e) => setForm({ ...form, categoriaDetalhadaId: e.target.value })} disabled={!form.categoriaMacroId}><option value="">Sem detalhamento</option>{(macroSelecionada?.filhas || []).map((categoria) => <option key={categoria.id} value={categoria.id}>{categoria.emoji || ''} {categoria.nome}</option>)}</select>
            </label>
          </div>
        </div>

        <label className="compras-field compras-form-observacoes">
          <span className="compras-field-label">Observações</span>
          <textarea value={form.observacao} onChange={(e) => setForm({ ...form, observacao: e.target.value })} rows="3" placeholder="Ex.: modelo desejado, motivo da compra, condição mínima..." />
        </label>

        <div className="compras-form-actions">
          <Btn type="submit" variant="primary" disabled={salvando}>{salvando ? 'Salvando...' : editandoId ? 'Salvar alterações' : 'Cadastrar compra'}</Btn>
        </div>
      </form>'''

text = text[:start] + novo + text[end:]
path.write_text(text, encoding='utf-8')
