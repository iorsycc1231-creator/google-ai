export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { image, mimeType } = req.body;
    if (!image || !mimeType) return res.status(400).json({ error: '画像データがありません' });

    const apiKey = process.env.CLAUDE_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'APIキーが設定されていません' });

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 1024,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mimeType, data: image } },
            { type: 'text', text: `この画像がレシート・領収書でない場合は {"error":"レシートではありません"} のみ返してください。

レシート・領収書の場合は以下のルールでJSONのみ返してください。説明不要。

重要ルール：
- nameはレシートに印字された文字を一字一句そのままコピー。要約・翻訳・省略・変換禁止
- カタカナは特に正確に：ン/ツ/ソ/リ/ー/ポ/ボ/パ/バなど濁点・半濁点・長音符を正確に読む
- amountは税込金額の数値のみ（カンマなし、符号あり）
- 【最重要】「割引」「値引」「クーポン」「Code128」「ポイント」などのマイナス行は、レシートに「-」がついていれば必ずamountを負の整数で返す。例：レシートに「-49」とあれば amount: -49
- tax_categoryは「※」「★」「軽」「#」マークがあれば「8%軽減」、なければ「10%標準」
- invoice_numberは「T」で始まる13桁の番号、なければnull
- dateはYYYY-MM-DD形式（令和8年=2026年、令和7年=2025年）
- totalは税込の実際の支払合計金額（「合計」「お会計」欄の金額）
- tax_8：レシートに記載された8%消費税額。「外税額 8%」「消費税8%」「内消費税等8%」どの形式でも必ず読み取る。なければnull
- tax_10：レシートに記載された10%消費税額。同様に必ず読み取る。なければnull
- accountは以下のルールで判定する：
  ・店名や品目に「駐車場」「パーキング」→「駐車代」
  ・「交通」「タクシー」「Uber」「uber」→「タクシー代」
  ・「飲料」「ドリンク」「ジュース」「カゴメ」「お茶」「緑茶」「麦茶」「ほうじ茶」「コーヒー」「コーラ」「サイダー」「水」→「飲料代」
  ・飲食店（レストラン・カフェ・定食・ラーメン・寿司・居酒屋等）→「飲食代」
  ・店名に「コーナン」が含まれる場合、全品目→「消耗品」
  ・「ティッシュ」「トイレ」「洗剤」「作業着」「手袋」「軍手」→「消耗品」
  ・「自賠責」→「自賠責保険代」
  ・上記以外→「雑費」

{"store_name":"店名","invoice_number":"T+13桁またはnull","date":"YYYY-MM-DD","items":[{"name":"印字文字そのまま","amount":数値(値引きは必ず負の数),"tax_category":"10%標準または8%軽減または非課税","account":"駐車代/タクシー代/飲料代/飲食代/消耗品/自賠責保険代/雑費のいずれか"}],"tax_8":数値またはnull,"tax_10":数値またはnull,"total":数値}` }
          ]
        }]
      })
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      return res.status(response.status).json({ error: err?.error?.message || 'APIエラー' });
    }

    const data = await response.json();
    const raw = data?.content?.[0]?.text || '';
    let text = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
    const s = text.indexOf('{'), e = text.lastIndexOf('}');
    if (s === -1 || e === -1) return res.status(500).json({ error: 'JSONが見つかりません' });
    const parsed = JSON.parse(text.slice(s, e + 1));

    // レシートでないと判定された場合
    if (parsed.error) {
      return res.status(400).json({ error: parsed.error });
    }

    // 値引き行（amountが負）を直前の品目に統合する
    const validAccounts = ['駐車代','タクシー代','飲料代','飲食代','打ち合わせ','残業食事代','草刈り食事代','消耗品','自賠責保険代','不明','雑費','会費'];
    if (Array.isArray(parsed.items)) {
      // フォールバック：名前に割引キーワードがあるのにamountが正の場合は強制的にマイナスにする
      const discountPattern = /割引|値引|クーポン|ポイント|code\d+|discount/i;
      parsed.items = parsed.items.map(item => {
        const amount = Number(item.amount) || 0;
        if (discountPattern.test(item.name) && amount > 0) {
          return { ...item, amount: -amount };
        }
        return { ...item, amount };
      });

      const merged = [];
      for (const item of parsed.items) {
        const amount = Number(item.amount) || 0;
        if (amount < 0 && merged.length > 0) {
          // 直前の品目のamountからマイナス分を引く
          merged[merged.length - 1].amount += amount;
        } else {
          merged.push({ ...item, amount });
        }
      }
      parsed.items = merged.map(item => ({
        ...item,
        account: validAccounts.includes(item.account) ? item.account : '雑費'
      }));
    }

    return res.status(200).json(parsed);

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
