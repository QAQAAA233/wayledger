// PayPal's own Agent Toolkit, loaded only when a tool first needs it so ordinary requests start fast.
// The toolkit hands back JSON text; this adapter returns parsed objects.
export function createToolkit({ clientId, secret }) {
  let tools = null;
  const load = async () => {
    if (!tools) {
      const { PayPalAgentToolkit } = await import('@paypal/agent-toolkit/ai-sdk');
      tools = new PayPalAgentToolkit({
        clientId,
        clientSecret: secret,
        configuration: { actions: { orders: { get: true }, payments: { getRefunds: true }, disputes: { list: true, get: true } }, context: { sandbox: true } },
      }).getTools();
    }
    return tools;
  };
  const call = (name) => async (args) => {
    const tool = (await load())[name];
    const out = await tool.execute(args, { toolCallId: name, messages: [] });
    return typeof out === 'string' ? JSON.parse(out) : out;
  };
  return { get_order: call('get_order'), get_refund: call('get_refund'), list_disputes: call('list_disputes') };
}
