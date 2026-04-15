type OrderRuleType = 'glob' | 'exact' | 'simple';

type OrderRule = {
	line: string;
	lineType: OrderRuleType;
};

export type { OrderRule, OrderRuleType };
