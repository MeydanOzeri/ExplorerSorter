type OrderRuleType = 'glob' | 'exact';

type OrderRule = {
	line: string;
	lineType: OrderRuleType;
};

export type { OrderRule, OrderRuleType };
