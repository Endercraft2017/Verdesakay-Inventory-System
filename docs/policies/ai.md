# AI use and data notice

DRAFT — provider, contractual restrictions and support contact require approval.

AI is optional and workspace-configured. Conversations and authorized tool/retrieval results can be sent to the selected OpenAI-compatible provider. Administrators must verify its data region, retention, training opt-out, subprocessor terms and spending controls before enabling it. Provider/configuration/contact: [OWNER]. Do not enter secrets, credentials or unnecessary personal/regulated data.

Generated answers may be wrong, incomplete or influenced by untrusted source text. Check references and business calculations. Do not use AI as the sole basis for employment, payroll, credit, legal or safety decisions. In production, the server blocks AI tools that directly change business records or send communications; authorized reads, report generation and form proposals remain available. Users perform and approve changes in the normal application screens.

This restriction is enforced only when the server runs with `NODE_ENV=production`; release operators must verify that setting. AI request timeouts and tenant token caps do not replace hard provider billing limits. Report suspected leakage, unsafe results or prompt injection to [OWNER] with a minimal redacted example. No assurance of complete prompt-injection resistance or automated compliance is made.
