package output

import (
	"encoding/json"
	"fmt"
	"os"

	"github.com/itchyny/gojq"
)

func ApplyJQ(data any, expr string) (any, error) {
	query, err := gojq.Parse(expr)
	if err != nil {
		return nil, fmt.Errorf("jq 表达式解析失败: %w", err)
	}

	iter := query.Run(data)
	var results []any
	for {
		v, ok := iter.Next()
		if !ok {
			break
		}
		if err, isErr := v.(error); isErr {
			return nil, fmt.Errorf("jq 执行错误: %w", err)
		}
		results = append(results, v)
	}

	if len(results) == 1 {
		return results[0], nil
	}
	return results, nil
}

func PrintJQResult(data any, expr string) error {
	result, err := ApplyJQ(data, expr)
	if err != nil {
		return err
	}

	switch v := result.(type) {
	case string:
		fmt.Println(v)
	case nil:
		fmt.Println("null")
	default:
		enc := json.NewEncoder(os.Stdout)
		enc.SetIndent("", "  ")
		_ = enc.Encode(v)
	}
	return nil
}
